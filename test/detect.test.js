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
