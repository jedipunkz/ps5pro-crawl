/**
 * 環境変数の読み取り。
 *
 * GitHub Actions は未設定の `vars.FOO` を「空文字」として渡してくる。
 * `process.env.FOO ?? 既定値` は空文字を弾かないので、そのまま数値変換すると
 * 0 になり、時間予算 0 秒やしきい値 0 といった事故になる。
 * 未設定と空文字は同じ「指定なし」として扱う。
 */
export function envStr(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

export function envInt(name, fallback, { min } = {}) {
  const raw = envStr(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`環境変数 ${name} に数値以外が設定されています: "${raw}"`);
  }
  if (min !== undefined && n < min) {
    throw new Error(`環境変数 ${name} は ${min} 以上である必要があります: ${n}`);
  }
  return n;
}

export function envBool(name, fallback) {
  const raw = envStr(name);
  if (raw === null) return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
}

/** CLI 引数の数値。こちらも空文字や不正値を黙って 0 にしない */
export function parseInteger(value, label, { min } = {}) {
  // Number('') は 0 になってしまうので、空文字は先に弾く
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${label} に数値以外が指定されています: "${value ?? ''}"`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} に数値以外が指定されています: "${value}"`);
  if (min !== undefined && n < min) throw new Error(`${label} は ${min} 以上である必要があります: ${n}`);
  return n;
}
