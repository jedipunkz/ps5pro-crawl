import { parseArgs } from 'node:util';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, selectTargets } from './config.js';
import { fetchHttp, BrowserPool } from './fetcher.js';
import { detect } from './detect.js';
import { loadState, saveState } from './state.js';
import { notifyStock, notifyErrors, notifyTest } from './discord.js';
import { probeTargets, renderProbeTable } from './probe.js';
import { computeTransitions } from './transitions.js';
import { envStr, envInt, envBool, parseInteger } from './env.js';
import { fetchOfficialRetailers, diffAgainstConfig } from './official.js';
import { IN_STOCK, OUT_OF_STOCK, UNKNOWN, ERROR, LINK_DEAD, LABEL, EMOJI } from './status.js';

// 引数と環境変数の解釈はここで完結させ、設定ミスはスタックトレースではなく
// 一行のメッセージで返す
function parseOptions() {
  return parseArgs({
  options: {
    config: { type: 'string', default: 'config/targets.json' },
    state: { type: 'string', default: envStr('STATE_FILE', '.state/state.json') },
    only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'http-only': { type: 'boolean', default: false },
    'include-disabled': { type: 'boolean', default: false },
    'include-blocked': { type: 'boolean', default: envBool('INCLUDE_BLOCKED', false) },
    'no-state': { type: 'boolean', default: false },
    'test-notify': { type: 'boolean', default: false },
    'dump-dir': { type: 'string' },
    'check-official': { type: 'boolean', default: false },
    probe: { type: 'boolean', default: false },
    'probe-repeat': { type: 'string', default: '3' },
    'budget-ms': { type: 'string', default: String(envInt('BUDGET_MS', 300000, { min: 1000 })) },
    concurrency: { type: 'string', default: String(envInt('CONCURRENCY', 3, { min: 1 })) },
    help: { type: 'boolean', default: false },
  },
  }).values;
}

let argv;
try {
  argv = parseOptions();
} catch (err) {
  console.error(`設定エラー: ${err.message}`);
  process.exit(1);
}

if (argv.help) {
  console.log(`使い方: node src/index.js [options]

  --config <path>       ターゲット定義 (default: config/targets.json)
  --state <path>        状態ファイル (default: .state/state.json)
  --only <id,id>        指定 id だけをクロール
  --http-only           http モードのターゲットのみ（Chromium 不要）
  --include-disabled    enabled:false のターゲットをすべて対象にする
  --include-blocked     回線起因で無効にした店舗を戻す（自宅回線のランナー向け）
  --dry-run             Discord に通知せず結果を標準出力するだけ
  --no-state            前回状態を読まず・書かない（在庫ありなら必ず通知される）
  --test-notify         在庫を見ずに Discord へ疎通テストだけ送って終了
  --dump-dir <path>     取得した HTML と抽出テキストを保存する（判定を直すとき用）
  --check-official      公式ページの販売店リンクと設定の差分を出す
  --probe               取得方法ごとの成否を実測する（通知しない）
  --probe-repeat <n>    --probe の試行回数 (default: 3)
  --budget-ms <ms>      全体の時間予算。超えた分は打ち切る (default: 300000)
  --concurrency <n>     並列数 (default: 3)

環境変数:
  DISCORD_WEBHOOK_URL   通知先 Webhook（--dry-run 以外では必須）
  DISCORD_MENTION       在庫検知時に付けるメンション（例: <@&123>, @here）
  NOTIFY_ON_ERROR       true で連続取得失敗も通知する
  ERROR_THRESHOLD       連続失敗の通知しきい値 (default: 3)
  NOTIFY_ON_SOLD_OUT    false で「在庫あり→在庫なし」通知を止める (default: true)
  INCLUDE_BLOCKED       true で回線起因で無効にした店舗を戻す（セルフホストランナー向け）
  BUDGET_MS             全体の時間予算 (default: 300000)
`);
  process.exit(0);
}

let DRY_RUN, CONCURRENCY, BUDGET_MS, WEBHOOK, ERROR_THRESHOLD;
let NOTIFY_ON_ERROR, NOTIFY_ON_SOLD_OUT, DISCORD_MENTION;
try {
  DRY_RUN = argv['dry-run'];
  CONCURRENCY = parseInteger(argv.concurrency, '--concurrency', { min: 1 });
  BUDGET_MS = parseInteger(argv['budget-ms'], '--budget-ms', { min: 1000 });
  WEBHOOK = envStr('DISCORD_WEBHOOK_URL');
  ERROR_THRESHOLD = envInt('ERROR_THRESHOLD', 3, { min: 1 });
  NOTIFY_ON_ERROR = envBool('NOTIFY_ON_ERROR', false);
  NOTIFY_ON_SOLD_OUT = envBool('NOTIFY_ON_SOLD_OUT', true);
  DISCORD_MENTION = envStr('DISCORD_MENTION');
} catch (err) {
  console.error(`設定エラー: ${err.message}`);
  process.exit(1);
}

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

async function checkTarget(target, browser, dumpDir, deadline) {
  const base = { id: target.id, name: target.name, url: target.url, verified: target.verified };
  if (Date.now() > deadline) {
    return { ...base, status: ERROR, reason: '時間予算切れのため未実行', httpStatus: null, price: null };
  }
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
  const path = envStr('GITHUB_STEP_SUMMARY');
  if (!path) return;
  await appendFile(path, lines.join('\n') + '\n');
}

async function main() {
  const config = await loadConfig(argv.config);

  if (argv['test-notify']) {
    if (!WEBHOOK) throw new Error('DISCORD_WEBHOOK_URL が未設定です');
    await notifyTest(WEBHOOK, {
      productName: config.product?.name,
      mention: DISCORD_MENTION,
    });
    console.log('Discord に疎通テストを送信しました');
    return;
  }

  const targets = selectTargets(config.targets, {
    only: argv.only?.split(',').map((s) => s.trim()).filter(Boolean),
    httpOnly: argv['http-only'],
    includeDisabled: argv['include-disabled'],
    includeBlocked: argv['include-blocked'],
  });

  if (targets.length === 0) throw new Error('クロール対象が 0 件です');
  if (!DRY_RUN && !argv.probe && !WEBHOOK) {
    throw new Error('DISCORD_WEBHOOK_URL が未設定です（通知しない場合は --dry-run を使ってください）');
  }

  const productName = config.product?.name ?? 'PS5 Pro';
  const state = argv['no-state'] ? { version: 1, targets: {} } : await loadState(argv.state);

  console.log(`${productName} の在庫チェックを開始 (${targets.length} 店舗 / 並列 ${CONCURRENCY})`);

  // 1 店舗のハングでジョブ全体が制限時間に達し、通知まで到達しないのを防ぐ。
  // 実際に、ビックカメラの 30 秒タイムアウト x 3 回でジョブがキャンセルされた。
  const deadline = Date.now() + BUDGET_MS;

  if (argv.probe) {
    console.log('取得方法ごとの成否を実測します（通知はしません）');
    const rows = await probeTargets(targets, {
      repeat: parseInteger(argv['probe-repeat'], '--probe-repeat', { min: 1 }),
    });
    const table = renderProbeTable(rows);
    console.log('\n' + table.join('\n'));
    await writeStepSummary(table);
    if (argv['dump-dir']) {
      await mkdir(argv['dump-dir'], { recursive: true });
      await writeFile(join(argv['dump-dir'], 'probe.json'), JSON.stringify(rows, null, 2));
      await writeFile(join(argv['dump-dir'], 'probe.md'), table.join('\n') + '\n');
    }
    return;
  }

  const needsBrowser = targets.some((t) => t.mode === 'browser');
  const browser = needsBrowser ? new BrowserPool() : null;

  let results;
  try {
    results = await pool(targets, CONCURRENCY, async (t) => {
      const r = await checkTarget(t, browser, argv['dump-dir'], deadline);
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

  const unhealthy = results.filter(
    (r) => r.status === ERROR || r.status === UNKNOWN || r.status === LINK_DEAD,
  );
  if (unhealthy.length) {
    summary.push(
      '',
      `判定できなかった店舗が ${unhealthy.length} 件あります。`,
      '`実行内容: diagnose` で手動実行すると、実際に取得した HTML がアーティファクトに保存され、',
      '`config/targets.json` の `selector` / `outOfStock` / `inStock` を実データに合わせて直せます。',
    );
  }
  await writeStepSummary(summary);

  if (argv['check-official']) {
    // 公式ページのリンクは実際に古くなる。SIE が直したときに気づけるようにする
    try {
      const retailers = await fetchOfficialRetailers(config.product?.officialPage);
      const diff = diffAgainstConfig(retailers, config.targets);
      const lines = [
        '',
        `### 公式ページの販売店リンク（${diff.retailerCount} 店舗）`,
        '',
        ...retailers.map((r) => `- ${r.name}: ${r.url}`),
      ];
      if (diff.onlyOnOfficial.length) {
        lines.push('', '**公式ページにあって設定に無い URL（リンクが更新された可能性）**', '');
        lines.push(...diff.onlyOnOfficial.map((r) => `- ⚠️ ${r.name}: ${r.url}`));
      } else {
        lines.push('', '公式ページのリンクに変更はありません。');
      }
      console.log(lines.join('\n'));
      await writeStepSummary(lines);
      if (argv['dump-dir']) {
        await mkdir(argv['dump-dir'], { recursive: true });
        await writeFile(join(argv['dump-dir'], 'official-retailers.json'), JSON.stringify(retailers, null, 2));
      }
    } catch (err) {
      console.warn(`公式ページの確認に失敗しました: ${err.message}`);
    }
  }

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
        mention: DISCORD_MENTION,
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
