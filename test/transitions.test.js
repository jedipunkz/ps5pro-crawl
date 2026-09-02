import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTransitions } from '../src/transitions.js';
import { IN_STOCK, OUT_OF_STOCK, UNKNOWN, ERROR } from '../src/status.js';

const r = (status) => [{ id: 'x', name: 'X', url: 'https://example.com', status, reason: '' }];
const stateOf = (t) => ({ version: 1, targets: t ? { x: t } : {} });

test('初回に在庫ありなら通知する', () => {
  const t = computeTransitions(r(IN_STOCK), stateOf(null), 3);
  assert.equal(t.newlyInStock.length, 1);
});

test('在庫ありが続いても再通知しない', () => {
  const t = computeTransitions(r(IN_STOCK), stateOf({ lastKnownStatus: IN_STOCK }), 3);
  assert.equal(t.newlyInStock.length, 0);
});

test('在庫なしが続いても通知しない', () => {
  const t = computeTransitions(r(OUT_OF_STOCK), stateOf({ lastKnownStatus: OUT_OF_STOCK }), 3);
  assert.equal(t.newlyInStock.length, 0);
  assert.equal(t.nowSoldOut.length, 0);
});

test('在庫あり → 在庫なし を検知する', () => {
  const t = computeTransitions(r(OUT_OF_STOCK), stateOf({ lastKnownStatus: IN_STOCK }), 3);
  assert.equal(t.nowSoldOut.length, 1);
});

test('403 を挟んでも在庫ありを再通知しない（最重要）', () => {
  let state = stateOf({ lastKnownStatus: IN_STOCK });
  state = computeTransitions(r(ERROR), state, 3).nextState;
  assert.equal(state.targets.x.lastKnownStatus, IN_STOCK, 'エラー時は最後の確定状態を保持する');

  const t = computeTransitions(r(IN_STOCK), state, 3);
  assert.equal(t.newlyInStock.length, 0, 'エラー復帰だけで再通知してはいけない');
});

test('連続失敗がしきい値に達したときだけエラー通知する', () => {
  let state = stateOf(null);
  const fired = [];
  for (let i = 0; i < 5; i++) {
    const t = computeTransitions(r(UNKNOWN), state, 3);
    fired.push(t.persistentErrors.length);
    state = t.nextState;
  }
  assert.deepEqual(fired, [0, 0, 1, 0, 0], 'しきい値ちょうどで1回だけ通知する');
});

test('取得成功したら連続失敗カウンタがリセットされる', () => {
  const state = stateOf({ lastKnownStatus: OUT_OF_STOCK, consecutiveFailures: 2 });
  const t = computeTransitions(r(OUT_OF_STOCK), state, 3);
  assert.equal(t.nextState.targets.x.consecutiveFailures, 0);
});
