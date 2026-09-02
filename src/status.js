export const IN_STOCK = 'IN_STOCK';
export const OUT_OF_STOCK = 'OUT_OF_STOCK';
export const UNKNOWN = 'UNKNOWN';
// 200 が返るのに商品が存在しないページ。在庫なしとは意味が違い、URL の修正が要る
export const LINK_DEAD = 'LINK_DEAD';
export const ERROR = 'ERROR';

export const LABEL = {
  [IN_STOCK]: '在庫あり',
  [OUT_OF_STOCK]: '在庫なし',
  [UNKNOWN]: '判定不能',
  [LINK_DEAD]: 'ページ消滅',
  [ERROR]: '取得失敗',
};

export const EMOJI = {
  [IN_STOCK]: '🟢',
  [OUT_OF_STOCK]: '⚪',
  [UNKNOWN]: '🟡',
  [LINK_DEAD]: '🔗',
  [ERROR]: '🔴',
};
