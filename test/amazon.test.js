import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { detect } from '../src/detect.js';
import { isAmazonOffer } from '../src/amazon.js';
import { IN_STOCK, OUT_OF_STOCK, UNKNOWN } from '../src/status.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = await loadConfig(join(here, '..', 'config', 'targets.json'));
const target = config.targets.find((t) => t.id === 'amazon');

// fixtures は 2026-10-16 にお届け先 100-0001 で取得した新品のみの出品一覧 (AOD)。
// in-stock は PS5 Pro ではなく、Amazon.co.jp が販売している別商品
// (ディスクドライブ B0CKYKPKD3) の実データ。
const fixture = async (name) =>
  gunzipSync(await readFile(join(here, 'fixtures', `amazon.${name}.html.gz`))).toString('utf8');

test('amazon: Amazon.co.jp 販売の新品があれば IN_STOCK と価格を返す', async () => {
  const r = detect(target, await fixture('in-stock'));
  assert.equal(r.status, IN_STOCK, r.reason);
  assert.equal(r.price, '￥11,849');
});

test('amazon: マケプレ業者の新品だけなら OUT_OF_STOCK（転売価格で通知しない）', async () => {
  const r = detect(target, await fixture('marketplace-only'));
  assert.equal(r.status, OUT_OF_STOCK, r.reason);
  assert.match(r.reason, /他出品者の新品 3 件/);
  assert.equal(r.price, null);
});

test('amazon: 新品の出品が無ければ OUT_OF_STOCK', async () => {
  const r = detect(target, await fixture('out-of-stock'));
  assert.equal(r.status, OUT_OF_STOCK, r.reason);
});

test('amazon: 出品一覧でないページ（米国向け商品ページ等）は UNKNOWN', () => {
  const html = `<html><body><div id="availability">残り12点 ご注文はお早めに</div>${'商品説明 '.repeat(100)}</body></html>`;
  const r = detect(target, html);
  assert.equal(r.status, UNKNOWN);
});

test('amazon: ボット確認ページは UNKNOWN', () => {
  const html = `<html><body>JavaScript is disabled In order to continue, we need to verify that you're not a robot. This requires JavaScript.</body></html>`;
  const r = detect(target, html);
  assert.equal(r.status, UNKNOWN);
  assert.match(r.reason, /ボット判定/);
});

test('isAmazonOffer: seller ID があれば ID で判定し、名前の騙りを通さない', () => {
  assert.equal(isAmazonOffer({ seller: 'Amazon.co.jp', sellerId: null }), true);
  assert.equal(isAmazonOffer({ seller: 'Amazon.co.jp', sellerId: 'A3R5D9M20ZZU3D' }), false);
  assert.equal(isAmazonOffer({ seller: 'Amazonアウトレット風ショップ', sellerId: null }), false);
});

test('config: amazon 指定は browser モードと正しい ASIN を要求する', async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'ps5pro-'));
  const write = async (t) => {
    const p = join(dir, 'c.json');
    await writeFile(p, JSON.stringify({ targets: [{ id: 'a', name: 'a', url: 'https://example.com', ...t }] }));
    return p;
  };
  await assert.rejects(loadConfig(await write({ mode: 'http', amazon: { asin: 'B0DGT79B1T', postalCode: '100-0001' } })), /browser/);
  await assert.rejects(loadConfig(await write({ mode: 'browser', amazon: { asin: 'bad', postalCode: '100-0001' } })), /asin/);
  await assert.rejects(loadConfig(await write({ mode: 'browser', amazon: { asin: 'B0DGT79B1T', postalCode: '1000001' } })), /postalCode/);
});
