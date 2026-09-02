const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 素の fetch でも実ブラウザに近いヘッダを送らないと 403 を返す EC が多い
const HTTP_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} (${url})`);
    this.status = status;
  }
}

/** 指数バックオフ + ジッタ。相手サイトに連打しないための最低限の礼儀 */
async function withRetry(fn, retries, label) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      // 404 / 403 はリトライしても結果が変わらないので即座に諦める
      if (err instanceof HttpError && [403, 404, 410].includes(err.status)) break;
      if (attempt === retries) break;
      const backoff = 1000 * 2 ** attempt + Math.floor(Math.random() * 500);
      console.warn(`  [${label}] retry ${attempt + 1}/${retries}: ${err.message} (${backoff}ms 待機)`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

export async function fetchHttp(target) {
  return withRetry(
    async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), target.timeoutMs);
      try {
        const res = await fetch(target.url, {
          headers: HTTP_HEADERS,
          redirect: 'follow',
          signal: ac.signal,
        });
        if (!res.ok) throw new HttpError(res.status, target.url);
        return { html: await res.text(), finalUrl: res.url, status: res.status };
      } finally {
        clearTimeout(timer);
      }
    },
    target.retries,
    target.id,
  );
}

/**
 * ヘッドレス Chromium。ボット対策や非同期描画のあるサイト用。
 * ブラウザは全ターゲットで 1 プロセスを使い回す（起動が最も高コストなため）。
 */
export class BrowserPool {
  #browser = null;
  #context = null;

  async #ensure() {
    if (this.#context) return this.#context;
    const { chromium } = await import('playwright');
    const launchOptions = {
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    };
    if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    }
    if (process.env.CRAWLER_PROXY) {
      launchOptions.proxy = { server: process.env.CRAWLER_PROXY };
    }
    this.#browser = await chromium.launch(launchOptions);
    this.#context = await this.#browser.newContext({
      userAgent: UA,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8' },
    });
    // navigator.webdriver を隠す。これだけで通る簡易ボット判定がまだ多い
    await this.#context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return this.#context;
  }

  async fetch(target) {
    const ctx = await this.#ensure();
    return withRetry(
      async () => {
        const page = await ctx.newPage();
        // 画像・フォント・動画は在庫判定に不要なので落として転送量と時間を削る
        await page.route('**/*', (route) => {
          const type = route.request().resourceType();
          if (['image', 'media', 'font'].includes(type)) return route.abort();
          return route.continue();
        });
        try {
          const res = await page.goto(target.url, {
            waitUntil: 'domcontentloaded',
            timeout: target.timeoutMs,
          });
          const status = res?.status() ?? 0;
          if (status >= 400) throw new HttpError(status, target.url);
          if (target.waitForSelector) {
            await page
              .waitForSelector(target.waitForSelector, { timeout: 8000 })
              .catch(() => {});
          }
          await page.waitForTimeout(1500); // 在庫欄の遅延描画ぶんの猶予
          return { html: await page.content(), finalUrl: page.url(), status };
        } finally {
          await page.close().catch(() => {});
        }
      },
      target.retries,
      target.id,
    );
  }

  async close() {
    await this.#context?.close().catch(() => {});
    await this.#browser?.close().catch(() => {});
    this.#context = null;
    this.#browser = null;
  }
}
