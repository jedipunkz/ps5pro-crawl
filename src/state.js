import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY = { version: 1, updatedAt: null, targets: {} };

/**
 * 前回結果。これが無いと毎回「在庫あり」を通知してしまうため、
 * Actions では cache で持ち回す。失われても壊れず、重複通知が 1 回出るだけ。
 */
export async function loadState(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state?.version !== 1 || typeof state.targets !== 'object') return { ...EMPTY };
    return state;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`state 読み込み失敗 (${err.message})。空の state で続行します`);
    }
    return { ...EMPTY };
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}
