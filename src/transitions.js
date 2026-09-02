import { IN_STOCK, OUT_OF_STOCK, UNKNOWN, ERROR, LINK_DEAD } from './status.js';

/**
 * 前回状態と今回結果を突き合わせ、通知すべき変化だけを取り出す。
 * 毎回通知しないのはもちろん、UNKNOWN / ERROR を経由しただけで
 * 「在庫あり」を再通知しないことが重要（サイト側の一時的な失敗が多いため）。
 */
export function computeTransitions(results, state, errorThreshold) {
  const newlyInStock = [];
  const nowSoldOut = [];
  const persistentErrors = [];
  const nextTargets = { ...state.targets };
  const now = new Date().toISOString();

  for (const r of results) {
    const prev = state.targets?.[r.id] ?? {};
    const failed = r.status === ERROR || r.status === UNKNOWN || r.status === LINK_DEAD;
    const consecutiveFailures = failed ? (prev.consecutiveFailures ?? 0) + 1 : 0;

    // UNKNOWN / ERROR では「最後に確定した状態」を維持する。
    // これがないと 403 を挟むたびに在庫ありを再通知してしまう。
    const lastKnown = failed ? (prev.lastKnownStatus ?? null) : r.status;

    if (r.status === IN_STOCK && prev.lastKnownStatus !== IN_STOCK) newlyInStock.push(r);
    if (r.status === OUT_OF_STOCK && prev.lastKnownStatus === IN_STOCK) nowSoldOut.push(r);
    if (consecutiveFailures === errorThreshold) {
      persistentErrors.push({ ...r, consecutiveFailures });
    }

    nextTargets[r.id] = {
      status: r.status,
      lastKnownStatus: lastKnown,
      reason: r.reason,
      consecutiveFailures,
      lastCheckedAt: now,
      lastInStockAt: r.status === IN_STOCK ? now : (prev.lastInStockAt ?? null),
    };
  }

  return {
    newlyInStock,
    nowSoldOut,
    persistentErrors,
    nextState: { ...state, targets: nextTargets },
  };
}
