import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { detect } from '../src/detect.js';
import { IN_STOCK, OUT_OF_STOCK } from '../src/status.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = await loadConfig(join(here, '..', 'config', 'targets.json'));

// fixtures は各販売店から実際に取得した HTML（gzip 済み）。
// in-stock 側は、その HTML の在庫文言だけを差し替えた合成データ。
const CASES = [
  ['edion-7100', OUT_OF_STOCK, IN_STOCK],
  ['sony-store', OUT_OF_STOCK, IN_STOCK],
  ['rakuten-books', OUT_OF_STOCK, IN_STOCK],
  ['yodobashi', OUT_OF_STOCK, IN_STOCK],
  ['nojima', OUT_OF_STOCK, IN_STOCK],
];

const fixture = async (id, kind) =>
  gunzipSync(await readFile(join(here, 'fixtures', `${id}.${kind}.html.gz`))).toString('utf8');

for (const [id, outExpected, inExpected] of CASES) {
  const target = config.targets.find((t) => t.id === id);

  test(`${id}: 在庫なしページを ${outExpected} と判定する`, async () => {
    const r = detect(target, await fixture(id, 'out-of-stock'));
    assert.equal(r.status, outExpected, r.reason);
    assert.equal(r.scoped, true, `selector "${target.selector}" が一致していません`);
  });

  test(`${id}: 在庫ありページを ${inExpected} と判定する`, async () => {
    const r = detect(target, await fixture(id, 'in-stock'));
    assert.equal(r.status, inExpected, r.reason);
  });
}

test('ブロックページは UNKNOWN になり、在庫ありと誤判定しない', async () => {
  const target = config.targets.find((t) => t.id === 'sony-store');
  const html = `<html><body>${'Access Denied '.repeat(50)} 在庫あり カートに入れる</body></html>`;
  const r = detect(target, html);
  assert.equal(r.status, 'UNKNOWN');
});

test('本文が極端に短いページは UNKNOWN になる', async () => {
  const target = config.targets.find((t) => t.id === 'sony-store');
  const r = detect(target, '<html><body>在庫あり</body></html>');
  assert.equal(r.status, 'UNKNOWN');
});

test('セレクタが一致しないページは UNKNOWN になる（サイト改修の検知）', async () => {
  const target = config.targets.find((t) => t.id === 'rakuten-books');
  const html = `<html><body><div>${'商品説明のダミーテキスト。'.repeat(60)} 在庫あり</div></body></html>`;
  const r = detect(target, html);
  assert.equal(r.status, 'UNKNOWN');
  assert.match(r.reason, /セレクタ/);
});

test('--include-blocked は回線起因の店舗だけを戻す（終了したサービスは戻さない）', async () => {
  const { selectTargets } = await import('../src/config.js');
  const opts = { only: null, httpOnly: false, includeDisabled: false };

  const normal = selectTargets(config.targets, opts).map((t) => t.id);
  const withBlocked = selectTargets(config.targets, { ...opts, includeBlocked: true }).map((t) => t.id);

  assert.ok(withBlocked.length > normal.length, '回線起因の店舗が戻っていません');
  assert.ok(withBlocked.includes('yodobashi'), 'ヨドバシは回線起因なので戻るべき');
  assert.ok(!withBlocked.includes('tsutaya'), 'サービス終了した TSUTAYA は戻してはいけない');
  assert.ok(!withBlocked.includes('sevennet'), 'リンク切れの 7net は戻してはいけない');
});

test('200 で返る「商品が存在しない」ページを在庫なしと混同せず LINK_DEAD にする', async () => {
  // Actions が実際に取得したエディオンのページ。HTTP 200 で 153KB あるのに
  // 本文は「選択された商品は、存在しません。」で、在庫なしではなく URL が古い。
  const target = config.targets.find((t) => t.id === 'edion');
  const html = gunzipSync(await readFile(join(here, 'fixtures', 'edion.link-dead.html.gz'))).toString('utf8');
  const r = detect(target, html);
  assert.equal(r.status, 'LINK_DEAD', r.reason);
  assert.match(r.reason, /存在しません/);
});

test('監視対象に PS5 Pro の両リビジョンが含まれている', () => {
  const enabled = config.targets.filter((t) => t.enabled).map((t) => t.url).join(' ');
  assert.match(enabled, /CFI-7100B01/, '新リビジョンが監視対象にない');
  assert.match(enabled, /CFI-7000B01/, '初期リビジョンが監視対象にない');
});

test('エディオンの在庫数を数値として読み分ける', async () => {
  const target = config.targets.find((t) => t.id === 'edion-7100');
  const soldOut = gunzipSync(
    await readFile(join(here, 'fixtures', 'edion-7100.out-of-stock.html.gz')),
  ).toString('utf8');

  // 在庫数だけを 0 -> 2 に変えても在庫ありと読めること。
  // 「売り切れ」表記が残っている間は在庫なしを優先する。
  const onlyCountChanged = soldOut.replace('在庫数0台', '在庫数2台');
  assert.equal(detect(target, onlyCountChanged).status, OUT_OF_STOCK, '売り切れ表記があるうちは在庫なし');

  const r = detect(target, soldOut.replace('在庫数0台', '在庫数2台').replaceAll('売り切れ', 'カートに入れる'));
  assert.equal(r.status, IN_STOCK, r.reason);
  assert.match(r.reason, /在庫数/);
});

test('script 内の文字列で「ページ消滅」と誤判定しない', () => {
  const target = config.targets.find((t) => t.id === 'edion-7100');
  const html = `<html><head><title>商品</title></head><body>
    <script>var msg = "選択された商品は、存在しません。";</script>
    <div class="limit1">在庫数0台</div>
    <div>${'商品説明のダミー。'.repeat(60)}</div>
  </body></html>`;
  const r = detect(target, html);
  assert.equal(r.status, OUT_OF_STOCK, r.reason);
});
