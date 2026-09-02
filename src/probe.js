import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const HEADERS = [
  'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language: ja-JP,ja;q=0.9',
  'Sec-Fetch-Dest: document',
  'Sec-Fetch-Mode: navigate',
  'Sec-Fetch-Site: none',
  'Sec-Fetch-User: ?1',
  'Upgrade-Insecure-Requests: 1',
];

async function viaCurl(url, { ua, http1 }) {
  const args = ['-sL', '--max-time', '20', '--compressed', '-A', ua, '-o', '/dev/null', '-w', '%{http_code} %{size_download}'];
  if (http1) args.push('--http1.1');
  for (const h of HEADERS) args.push('-H', h);
  args.push(url);
  try {
    const { stdout } = await execFileAsync('curl', args, { timeout: 30000 });
    const [code, size] = stdout.trim().split(/\s+/);
    return { status: Number(code), size: Number(size) };
  } catch (err) {
    return { status: 0, size: 0, error: err.message.slice(0, 80) };
  }
}

async function viaFetch(url, ua) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: Object.fromEntries([...HEADERS.map((h) => h.split(': ')), ['User-Agent', ua]]),
      signal: ac.signal,
    });
    const body = await res.text();
    return { status: res.status, size: body.length };
  } catch (err) {
    return { status: 0, size: 0, error: err.message.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

async function viaBrowser(url, { mobile }) {
  // 実測が目的なので、ブラウザが用意できないこと自体も結果として返す。
  // ここで例外を投げると測定全体が止まってしまう。
  let browser;
  let devices;
  try {
    const pw = await import('playwright');
    devices = pw.devices;
    const launchOptions = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    if (process.env.CRAWLER_PROXY) launchOptions.proxy = { server: process.env.CRAWLER_PROXY };
    browser = await pw.chromium.launch(launchOptions);
  } catch (err) {
    return { status: 0, size: 0, error: `起動できず: ${err.message.split('\n')[0].slice(0, 60)}` };
  }

  try {
    const ctx = await browser.newContext(
      mobile ? devices['iPhone 13'] : { userAgent: UA_DESKTOP, locale: 'ja-JP' },
    );
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const size = (await page.content()).length;
    return { status: res?.status() ?? 0, size };
  } catch (err) {
    return { status: 0, size: 0, error: err.message.split('\n')[0].slice(0, 80) };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * どの取得方法なら通るのかを、実行環境そのもので測る。
 * ローカルと Actions では IP が違い結果も違うので、推測ではなく実測する。
 */
export const STRATEGIES = [
  { id: 'fetch-h1-desktop', label: 'Node fetch (HTTP/1.1, PC UA)', run: (u) => viaFetch(u, UA_DESKTOP) },
  { id: 'curl-h2-desktop', label: 'curl (HTTP/2, PC UA)', run: (u) => viaCurl(u, { ua: UA_DESKTOP }) },
  { id: 'curl-h2-mobile', label: 'curl (HTTP/2, iPhone UA)', run: (u) => viaCurl(u, { ua: UA_MOBILE }) },
  { id: 'curl-h1-desktop', label: 'curl (HTTP/1.1, PC UA)', run: (u) => viaCurl(u, { ua: UA_DESKTOP, http1: true }) },
  { id: 'browser-desktop', label: 'Chromium (PC)', run: (u) => viaBrowser(u, { mobile: false }) },
  { id: 'browser-mobile', label: 'Chromium (iPhone)', run: (u) => viaBrowser(u, { mobile: true }) },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function probeTargets(targets, { repeat = 1 } = {}) {
  const rows = [];
  for (const target of targets) {
    const row = { id: target.id, name: target.name, url: target.url, results: {} };
    for (const s of STRATEGIES) {
      const attempts = [];
      for (let i = 0; i < repeat; i++) {
        attempts.push(await s.run(target.url));
        // 同じ相手に連打しない
        await sleep(1500);
      }
      const ok = attempts.filter((a) => a.status >= 200 && a.status < 300).length;
      row.results[s.id] = {
        ok,
        total: repeat,
        statuses: attempts.map((a) => a.status).join('/'),
        size: Math.max(...attempts.map((a) => a.size)),
      };
      console.log(
        `  ${target.name.padEnd(20)} ${s.label.padEnd(30)} ${ok}/${repeat} 成功 (${row.results[s.id].statuses})`,
      );
    }
    rows.push(row);
  }
  return rows;
}

export function renderProbeTable(rows) {
  const head = `| 販売店 | ${STRATEGIES.map((s) => s.label).join(' | ')} |`;
  const sep = `| --- | ${STRATEGIES.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => {
    const cells = STRATEGIES.map((s) => {
      const v = r.results[s.id];
      const mark = v.ok === v.total ? '✅' : v.ok > 0 ? '⚠️' : '❌';
      return `${mark} ${v.statuses}`;
    });
    return `| ${r.name} | ${cells.join(' | ')} |`;
  });
  return ['### 取得方法ごとの成否（この実行環境の IP から）', '', head, sep, ...body];
}
