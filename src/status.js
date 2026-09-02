export const IN_STOCK = 'IN_STOCK';
export const OUT_OF_STOCK = 'OUT_OF_STOCK';
export const UNKNOWN = 'UNKNOWN';
export const ERROR = 'ERROR';

export const LABEL = {
  [IN_STOCK]: '在庫あり',
  [OUT_OF_STOCK]: '在庫なし',
  [UNKNOWN]: '判定不能',
  [ERROR]: '取得失敗',
};

export const EMOJI = {
  [IN_STOCK]: '🟢',
  [OUT_OF_STOCK]: '⚪',
  [UNKNOWN]: '🟡',
  [ERROR]: '🔴',
};
