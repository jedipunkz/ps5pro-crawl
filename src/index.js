import { parseArgs } from 'node:util';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, selectTargets } from './config.js';
import { fetchHttp, BrowserPool } from './fetcher.js';
import { detect } from './detect.js';
import { loadState, saveState } from './state.js';
import { notifyStock, notifyErrors, notifyTest } from './discord.js';
import { computeTransitions } from './transitions.js';
import { IN_STOCK, OUT_OF_STOCK, UNKNOWN, ERROR, LABEL, EMOJI } from './status.js';

const { values: argv } = parseArgs({
  options: {
    config: { type: 'string', default: 'config/targets.json' },
    state: { type: 'string', default: process.env.STATE_FILE ?? '.state/state.json' },
    only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'http-only': { type: 'boolean', default: false },
    'include-disabled': { type: 'boolean', default: false },
    'no-state': { type: 'boolean', default: false },
    'test-notify': { type: 'boolean', default: false },
    'dump-dir': { type: 'string' },
    concurrency: { type: 'string', default: process.env.CONCURRENCY ?? '3' },
    help: { type: 'boolean', default: false },
  },
});

if (argv.help) {
  console.log(`使い方: node src/index.js [options]

  --config <path>       ターゲット定義 (default: config/targets.json)
  --state <path>        状態ファイル (default: .state/state.json)
  --only <id,id>        指定 id だけをクロール
  --http-only           http モードのターゲットのみ（Chromium 不要）
  --include-disabled    enabled:false のターゲットも対象にする
  --dry-run             Discord に通知せず結果を標準出力するだけ
  --no-state            前回状態を読まず・書かない（在庫ありなら必ず通知される）
  --test-notify         在庫を見ずに Discord へ疎通テストだけ送って終了
  --dump-dir <path>     取得した HTML と抽出テキストを保存する（判定を直すとき用）
  --concurrency <n>     並列数 (default: 3)

環境変数:
  DISCORD_WEBHOOK_URL   通知先 Webhook（--dry-run 以外では必須）
  DISCORD_MENTION       在庫検知時に付けるメンション（例: <@&123>, @here）
  NOTIFY_ON_ERROR       true で連続取得失敗も通知する
  ERROR_THRESHOLD       連続失敗の通知しきい値 (default: 3)
  NOTIFY_ON_SOLD_OUT    false で「在庫あり→在庫なし」通知を止める (default: true)
`);
  process.exit(0);
}

const DRY_RUN = argv['dry-run'];
const CONCURRENCY = Math.max(1, Number(argv.concurrency) || 3);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const ERROR_THRESHOLD = Number(process.env.ERROR_THRESHOLD ?? 3);
const NOTIFY_ON_ERROR = process.env.NOTIFY_ON_ERROR === 'true';
const NOTIFY_ON_SOLD_OUT = process.env.NOTIFY_ON_SOLD_OUT !== 'false';

const PRICE_RE = /([1-9][0-9,]{4,9})\s*円/;

/** 単純なワーカープール。相手サイトを同時に叩きすぎないよう並列数を絞る */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 判定を直すには実際に取得できた HTML が要る。ローカルで再現できない環境ほど重要 */
async function dump(dir, target, { html, text, note }) {
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  if (html) await writeFile(join(dir, `${target.id}.html`), html);
  if (text) await writeFile(join(dir, `${target.id}.txt`), text);
  if (note) await writeFile(join(dir, `${target.id}.note.txt`), note);
}

async function checkTarget(target, browser, dumpDir) {
  const base = { id: target.id, name: target.name, url: target.url, verified: target.verified };
  try {
    const { html, status } = target.mode === 'browser' ? await browser.fetch(target) : await fetchHttp(target);
    const { status: stockStatus, reason, text } = detect(target, html);
    await dump(dumpDir, target, {
      html,
      text,
      note: `url: ${target.url}\nmode: ${target.mode}\nhttp: ${status}\nselector: ${target.selector ?? '(なし)'}\n判定: ${stockStatus} — ${reason}\n`,
    });
    return {
      ...base,
      status: stockStatus,
      reason,
      httpStatus: status,
      price: text.match(PRICE_RE)?.[0] ?? null,
    };
  } catch (err) {
    // 403 の応答本文には遮断の理由（WAF 名や Reference ID）が入っていることが多い
    await dump(dumpDir, target, { html: err.body ?? null, note: `url: ${target.url}\nmode: ${target.mode}\nエラー: ${err.message}\n` });
    return { ...base, status: ERROR, reason: err.message, httpStatus: err.status ?? null, price: null };
  }
}

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

async function main() {
  const config = await loadConfig(argv.config);

  if (argv['test-notify']) {
    if (!WEBHOOK) throw new Error('DISCORD_WEBHOOK_URL が未設定です');
    await notifyTest(WEBHOOK, {
      productName: config.product?.name,
      mention: process.env.DISCORD_MENTION,
    });
    console.log('Discord に疎通テストを送信しました');
    return;
  }

  const targets = selectTargets(config.targets, {
    only: argv.only?.split(',').map((s) => s.trim()).filter(Boolean),
    httpOnly: argv['http-only'],
    includeDisabled: argv['include-disabled'],
  });

  if (targets.length === 0) throw new Error('クロール対象が 0 件です');
  if (!DRY_RUN && !WEBHOOK) {
    throw new Error('DISCORD_WEBHOOK_URL が未設定です（通知しない場合は --dry-run を使ってください）');
  }

  const productName = config.product?.name ?? 'PS5 Pro';
  const state = argv['no-state'] ? { version: 1, targets: {} } : await loadState(argv.state);

  console.log(`${productName} の在庫チェックを開始 (${targets.length} 店舗 / 並列 ${CONCURRENCY})`);

  const needsBrowser = targets.some((t) => t.mode === 'browser');
  const browser = needsBrowser ? new BrowserPool() : null;

  let results;
  try {
    results = await pool(targets, CONCURRENCY, async (t) => {
      const r = await checkTarget(t, browser, argv['dump-dir']);
      console.log(`${EMOJI[r.status]} ${r.name.padEnd(22)} ${LABEL[r.status]} — ${r.reason}`);
      return r;
    });
  } finally {
    await browser?.close();
  }

  const { newlyInStock, nowSoldOut, persistentErrors, nextState } = computeTransitions(
    results,
    state,
    ERROR_THRESHOLD,
  );

  const summary = [
    `### ${productName} 在庫チェック結果`,
    '',
    '| 販売店 | 状態 | 判定根拠 |',
    '| --- | --- | --- |',
    ...results.map((r) => `| [${r.name}](${r.url}) | ${EMOJI[r.status]} ${LABEL[r.status]} | ${r.reason ?? ''} |`),
  ];

  const unhealthy = results.filter((r) => r.status === ERROR || r.status === UNKNOWN);
  if (unhealthy.length) {
    summary.push(
      '',
      `判定できなかった店舗が ${unhealthy.length} 件あります。`,
      '`実行内容: diagnose` で手動実行すると、実際に取得した HTML がアーティファクトに保存され、',
      '`config/targets.json` の `selector` / `outOfStock` / `inStock` を実データに合わせて直せます。',
    );
  }
  await writeStepSummary(summary);

  if (argv['dump-dir']) {
    console.log(`\n取得結果を ${argv['dump-dir']}/ に保存しました`);
  }

  if (DRY_RUN) {
    console.log('\n--- dry-run のため通知はしません ---');
    console.log(`在庫あり: ${newlyInStock.length} / 在庫切れに変化: ${nowSoldOut.length} / 継続エラー: ${persistentErrors.length}`);
  } else {
    if (newlyInStock.length) {
      await notifyStock(WEBHOOK, {
        results: newlyInStock,
        productName,
        mention: process.env.DISCORD_MENTION,
      });
      console.log(`Discord に在庫通知を送信しました (${newlyInStock.length} 店舗)`);
    }
    if (nowSoldOut.length && NOTIFY_ON_SOLD_OUT) {
      await notifyStock(WEBHOOK, { results: nowSoldOut, productName });
      console.log(`Discord に在庫切れ通知を送信しました (${nowSoldOut.length} 店舗)`);
    }
    if (persistentErrors.length && NOTIFY_ON_ERROR) {
      await notifyErrors(WEBHOOK, { results: persistentErrors, threshold: ERROR_THRESHOLD });
    }
  }

  if (!argv['no-state']) await saveState(argv.state, nextState);

  // 全店舗が取得できていない場合だけ失敗にする（個別の 403 は日常なので落とさない）
  const healthy = results.filter((r) => r.status === IN_STOCK || r.status === OUT_OF_STOCK);
  if (healthy.length === 0) {
    console.error('すべての販売店で在庫判定に失敗しました');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`致命的エラー: ${err.stack ?? err.message}`);
  process.exit(1);
});
