import * as cheerio from 'cheerio';
import { IN_STOCK, OUT_OF_STOCK, UNKNOWN } from './status.js';

const ORIGIN = 'https://www.amazon.co.jp';

// Amazon.co.jp 自身の出品者 ID。マーケットプレイスの転売・中古と区別するのに使う
export const AMAZON_SELLER_ID = 'AN1VRQENFRJN5';

// 新品のみに絞った「すべての出品」(AOD)。商品ページの buybox は中古や
// マケプレ業者が取ることが多く、「残り12点」が Amazon の在庫とは限らないため
const AOD_NEW_FILTER = encodeURIComponent(JSON.stringify({ all: true, new: true }));

export function aodUrl(asin) {
  return `${ORIGIN}/gp/product/ajax/aodAjaxMain?asin=${encodeURIComponent(asin)}&pc=dp&filters=${AOD_NEW_FILTER}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * お届け先を日本の郵便番号に切り替える。
 *
 * Amazon はお届け先を IP から推定する。GitHub Actions は米国 IP なので
 * 既定のままだと「この商品は選択したお届け先には発送できません」になり、
 * 在庫の有無がページに出ない。
 */
async function setDeliveryLocation(page, postalCode, timeoutMs) {
  // 初回訪問ではボット確認の中間ページ（JS で自動遷移する）が返ることがある。
  // ナビバーのお届け先リンクが出るまで読み直す。
  let ready = false;
  for (let attempt = 0; attempt < 3 && !ready; attempt++) {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    ready = await page
      .waitForSelector('#nav-global-location-data-modal-action', { state: 'attached', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) await sleep(3000);
  }
  if (!ready) throw new Error('Amazon のトップページを取得できません（ボット確認ページの可能性）');

  const result = await page.evaluate(async (zipCode) => {
    const el = document.querySelector('#nav-global-location-data-modal-action');
    const modal = JSON.parse(el.getAttribute('data-a-modal') ?? '{}');
    const headers = { 'x-requested-with': 'XMLHttpRequest' };
    // お届け先モーダルの取得と変更で、別々の CSRF トークンが要る
    const html = await fetch(modal.url, {
      credentials: 'include',
      headers: { ...headers, 'anti-csrftoken-a2z': modal.ajaxHeaders?.['anti-csrftoken-a2z'] ?? '' },
    }).then((r) => r.text());
    const token = html.match(/CSRF_TOKEN\s*:\s*"([^"]+)"/)?.[1];
    if (!token) return { error: 'お届け先変更用の CSRF トークンが見つかりません' };

    const res = await fetch('/portal-migration/hz/glow/address-change?actionSource=glow', {
      method: 'POST',
      credentials: 'include',
      headers: { ...headers, 'Content-Type': 'application/json', 'anti-csrftoken-a2z': token },
      body: JSON.stringify({
        locationType: 'LOCATION_INPUT',
        zipCode,
        deviceType: 'web',
        storeContext: 'generic',
        pageType: 'Gateway',
        actionSource: 'glow',
      }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, updated: body?.isAddressUpdated === 1, country: body?.address?.countryCode };
  }, postalCode);

  if (result.error) throw new Error(result.error);
  if (!result.updated || result.country !== 'JP') {
    throw new Error(`お届け先を ${postalCode} に変更できませんでした (HTTP ${result.status})`);
  }
}

/**
 * ブラウザコンテキストごとに 1 回だけお届け先を設定する。
 * Cookie に保存されるので、以降のページはすべて日本向けの表示になる。
 */
const prepared = new WeakMap();

export async function prepareAmazon(context, { postalCode, timeoutMs }) {
  if (!prepared.has(context)) {
    const job = (async () => {
      // 価格を円で表示させる（米国 IP だと USD 表示になる）
      await context.addCookies([{ name: 'i18n-prefs', value: 'JPY', domain: '.amazon.co.jp', path: '/' }]);
      const page = await context.newPage();
      try {
        await setDeliveryLocation(page, postalCode, timeoutMs);
      } finally {
        await page.close().catch(() => {});
      }
    })();
    // 失敗したら次の呼び出しでやり直せるようにする
    job.catch(() => prepared.delete(context));
    prepared.set(context, job);
  }
  return prepared.get(context);
}

const clean = (s) => s.replace(/\s+/g, ' ').trim();

/** AOD の 1 出品を取り出す */
function parseOffer($, el) {
  const e = $(el);
  const soldBy = e.find('#aod-offer-soldBy');
  const sellerId = soldBy.find('a[href*="seller="]').attr('href')?.match(/seller=([A-Z0-9]+)/)?.[1] ?? null;
  return {
    condition: clean(e.find('#aod-offer-heading').text()),
    seller: clean(soldBy.find('.a-col-right').text() || soldBy.text()).replace(/^販売元\s*/, ''),
    sellerId,
    price: clean(e.find('.apex-pricetopay-value, .aok-offscreen').first().text()) || null,
  };
}

/**
 * 出品者が Amazon.co.jp 自身か。
 * マケプレ業者には seller= 付きのリンクがあり、Amazon 自身はヘルプページへの
 * リンクで ID が無い。ID があれば ID で、無ければ名前で判定する。
 */
export function isAmazonOffer(offer) {
  if (offer.sellerId) return offer.sellerId === AMAZON_SELLER_ID;
  return /^Amazon(\.co\.jp)?(\s|$)/.test(offer.seller);
}

/**
 * AOD の HTML から「Amazon.co.jp が販売する新品」の有無を判定する。
 * マケプレの新品（多くは定価超え）や中古は在庫ありとみなさない。
 */
export function detectAmazon(html) {
  const $ = cheerio.load(html);
  $('script, style').remove();
  const text = clean($('body').text());

  // AOD の外枠が無いならボット確認ページかサイト改修
  if ($('#aod-container, #all-offers-display-scroller, #aod-offer-list').length === 0) {
    return { status: UNKNOWN, reason: 'Amazon の出品一覧 (AOD) が取得できませんでした', text, price: null };
  }

  const offers = $('#aod-pinned-offer, [id="aod-offer"]')
    .toArray()
    .map((el) => parseOffer($, el))
    .filter((o) => o.seller);
  const own = offers.find((o) => isAmazonOffer(o) && /新品/.test(o.condition));

  if (own) {
    return {
      status: IN_STOCK,
      reason: `Amazon.co.jp 販売の新品出品あり${own.price ? ` (${own.price})` : ''}`,
      text,
      price: own.price,
    };
  }
  const others = offers.filter((o) => /新品/.test(o.condition)).length;
  return {
    status: OUT_OF_STOCK,
    reason: `Amazon.co.jp 販売の新品出品なし (他出品者の新品 ${others} 件)`,
    text,
    price: null,
  };
}
