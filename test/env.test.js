import test from 'node:test';
import assert from 'node:assert/strict';
import { envStr, envInt, envBool, parseInteger } from '../src/env.js';

const withEnv = (name, value, fn) => {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
};

// GitHub Actions は未設定の vars.FOO を空文字で渡してくる。
// これを 0 と解釈して時間予算が 0 秒になり、全店舗が打ち切られた実績がある。
test('空文字は未設定として扱い、既定値を返す', () => {
  withEnv('T_BUDGET', '', () => assert.equal(envInt('T_BUDGET', 300000), 300000));
  withEnv('T_BUDGET', '   ', () => assert.equal(envInt('T_BUDGET', 300000), 300000));
  withEnv('T_BUDGET', undefined, () => assert.equal(envInt('T_BUDGET', 300000), 300000));
});

test('空文字のしきい値を 0 にしない', () => {
  withEnv('T_TH', '', () => assert.equal(envInt('T_TH', 3), 3));
});

test('値が設定されていればそれを使う', () => {
  withEnv('T_BUDGET', '60000', () => assert.equal(envInt('T_BUDGET', 300000), 60000));
});

test('数値以外は既定値に落とさず、はっきり失敗させる', () => {
  withEnv('T_BUDGET', 'abc', () => assert.throws(() => envInt('T_BUDGET', 300000), /数値以外/));
});

test('下限を下回る値を弾く', () => {
  withEnv('T_BUDGET', '0', () =>
    assert.throws(() => envInt('T_BUDGET', 300000, { min: 1000 }), /以上/),
  );
});

test('真偽値は空文字で既定値、明示された値を優先する', () => {
  withEnv('T_FLAG', '', () => assert.equal(envBool('T_FLAG', true), true));
  withEnv('T_FLAG', '', () => assert.equal(envBool('T_FLAG', false), false));
  withEnv('T_FLAG', 'true', () => assert.equal(envBool('T_FLAG', false), true));
  withEnv('T_FLAG', 'false', () => assert.equal(envBool('T_FLAG', true), false));
  withEnv('T_FLAG', '1', () => assert.equal(envBool('T_FLAG', false), true));
});

test('文字列は空文字で既定値を返す', () => {
  withEnv('T_STR', '', () => assert.equal(envStr('T_STR', '.state/state.json'), '.state/state.json'));
  withEnv('T_STR', 'x.json', () => assert.equal(envStr('T_STR', '.state/state.json'), 'x.json'));
});

test('CLI 引数の数値も不正値を弾く', () => {
  assert.equal(parseInteger('5', '--concurrency'), 5);
  assert.throws(() => parseInteger('', '--concurrency'), /数値以外/);
  assert.throws(() => parseInteger('abc', '--concurrency'), /数値以外/);
  assert.throws(() => parseInteger('0', '--budget-ms', { min: 1000 }), /以上/);
});
