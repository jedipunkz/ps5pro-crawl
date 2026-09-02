import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { detect } from '../src/detect.js';
import { IN_STOCK, OUT_OF_STOCK } from '../src/status.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = await loadConfig(join(here, '..', 'config', 'targets.json'));

// 実際に各 WAF から返された遮断ページ。
// これらを「在庫あり」と誤読すると、深夜に無意味な通知が飛ぶ。
const BLOCK_PAGES = [
  ['cloudflare-challenge.html', 'Cloudflare の JS チャレンジ (エディオン)'],
  ['akamai-access-denied.html', 'Akamai の Access Denied (Joshin)'],
  ['biccamera-blocked.html', 'ビックカメラの遮断ページ'],
];

for (const [file, label] of BLOCK_PAGES) {
  // 全店舗の設定で試す。どの店舗の設定でも在庫ありにしてはいけない。
  for (const target of config.targets) {
    test(`${label} を ${target.id} の設定で在庫ありと誤判定しない`, async () => {
      const html = await readFile(join(here, 'fixtures', 'blocked', file), 'utf8');
      const r = detect(target, html);
      assert.notEqual(r.status, IN_STOCK, `誤検知: ${r.reason}`);
    });
  }
}

test('遮断ページに在庫文言が紛れ込んでいても在庫ありにしない', async () => {
  const target = config.targets.find((t) => t.id === 'edion');
  const html = await readFile(join(here, 'fixtures', 'blocked', 'cloudflare-challenge.html'), 'utf8');
  // 本文が長い遮断ページを模して、在庫文言を混ぜた最悪ケース
  const poisoned = html.replace('</body>', `<div>${'ダミー'.repeat(200)} カートに入れる 在庫あり</div></body>`);
  const r = detect(target, poisoned);
  assert.notEqual(r.status, IN_STOCK, r.reason);
});

test('TSUTAYA はサービス終了のため無効化されている', () => {
  const target = config.targets.find((t) => t.id === 'tsutaya');
  assert.equal(target.enabled, false);
  assert.match(target.note, /サービス終了/);
});

test('サービス終了ページを在庫ありと判定しない', async () => {
  const target = config.targets.find((t) => t.id === 'tsutaya');
  const html = await readFile(join(here, 'fixtures', 'blocked', 'tsutaya-service-ended.html'), 'utf8');
  const r = detect(target, html);
  assert.notEqual(r.status, IN_STOCK, r.reason);
});
