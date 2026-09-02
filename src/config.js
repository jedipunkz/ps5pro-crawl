import { readFile } from 'node:fs/promises';

const DEFAULTS = {
  timeoutMs: 30000,
  retries: 2,
  minTextLength: 300,
  blockedPatterns: [],
};

/**
 * targets.json を読み込み、defaults をマージした上で検証する。
 * 設定ミスは実行前に例外にして、無言の誤検知を避ける。
 */
export async function loadConfig(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const defaults = { ...DEFAULTS, ...(raw.defaults ?? {}) };

  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error(`${path}: targets が空です`);
  }

  const ids = new Set();
  const targets = raw.targets.map((t, i) => {
    for (const key of ['id', 'name', 'url']) {
      if (!t[key]) throw new Error(`${path}: targets[${i}] に ${key} がありません`);
    }
    if (ids.has(t.id)) throw new Error(`${path}: id が重複しています: ${t.id}`);
    ids.add(t.id);
    if (t.mode && !['http', 'browser'].includes(t.mode)) {
      throw new Error(`${path}: ${t.id} の mode が不正です: ${t.mode}`);
    }
    return {
      mode: 'http',
      selector: null,
      inStock: [],
      outOfStock: [],
      enabled: true,
      verified: false,
      note: null,
      warmupUrl: null,
      waitForSelector: null,
      settleMs: null,
      disableHttp2: false,
      ...t,
      timeoutMs: t.timeoutMs ?? defaults.timeoutMs,
      retries: t.retries ?? defaults.retries,
      minTextLength: t.minTextLength ?? defaults.minTextLength,
      blockedPatterns: t.blockedPatterns ?? defaults.blockedPatterns,
    };
  });

  return { product: raw.product ?? {}, defaults, targets };
}

/** CLI オプションでクロール対象を絞り込む */
export function selectTargets(targets, { only, httpOnly, includeDisabled }) {
  let list = targets;
  if (!includeDisabled) list = list.filter((t) => t.enabled);
  if (httpOnly) list = list.filter((t) => t.mode === 'http');
  if (only?.length) {
    const want = new Set(only);
    const unknown = only.filter((id) => !targets.some((t) => t.id === id));
    if (unknown.length) throw new Error(`--only に未知の id: ${unknown.join(', ')}`);
    list = list.filter((t) => want.has(t.id));
  }
  return list;
}
