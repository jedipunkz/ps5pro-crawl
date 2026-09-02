import * as cheerio from 'cheerio';

const OFFICIAL_URL = 'https://www.playstation.com/ja-jp/ps5/buy-now/ps5-pro/';

/**
 * 公式サイトの「販売店を選択」に載っている URL を取り出す。
 *
 * 公式のリンクは実際に古くなる（CFI-7000B01 のまま更新されていない）。
 * 設定との差分を出しておけば、SIE がリンクを直したときに気づける。
 */
export async function fetchOfficialRetailers(url = OFFICIAL_URL) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'ja-JP,ja;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`公式ページの取得に失敗しました: HTTP ${res.status}`);

  const $ = cheerio.load(await res.text());
  const retailers = [];
  $('.retail__content a[href^="http"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    // 店舗名は <noscript> の中の img[alt] にしかない。cheerio は noscript の
    // 中身を要素ではなくテキストとして持つので、DOM 走査では取れない。
    const inner = $(el).html() ?? '';
    const name =
      $(el).find('img').attr('alt') ??
      inner.match(/alt="([^"]+)"/)?.[1] ??
      $(el).attr('aria-label') ??
      '';
    retailers.push({ name: name.trim() || '(名称不明)', url: href });
  });
  return retailers;
}

export function diffAgainstConfig(retailers, targets) {
  const configured = new Set(targets.map((t) => t.url));
  const known = new Set(retailers.map((r) => r.url));
  return {
    onlyOnOfficial: retailers.filter((r) => !configured.has(r.url)),
    onlyInConfig: targets.filter((t) => !known.has(t.url)),
    retailerCount: retailers.length,
  };
}
