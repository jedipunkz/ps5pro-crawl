import { IN_STOCK, OUT_OF_STOCK, ERROR, LABEL, EMOJI } from './status.js';

const COLOR = {
  [IN_STOCK]: 0x2ecc71,
  [OUT_OF_STOCK]: 0x95a5a6,
  [ERROR]: 0xe74c3c,
};

/** Discord Webhook のレート制限に素直に従う（429 の retry_after を尊重） */
async function post(webhookUrl, payload, attempt = 0) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.status === 429 && attempt < 3) {
    const body = await res.json().catch(() => ({}));
    const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
    console.warn(`Discord rate limited. ${waitMs}ms 待機して再送します`);
    await new Promise((r) => setTimeout(r, waitMs));
    return post(webhookUrl, payload, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Discord webhook が失敗しました: HTTP ${res.status} ${await res.text()}`);
  }
}

export function buildStockEmbed(result, productName) {
  const fields = [
    { name: '販売店', value: result.name, inline: true },
    { name: '状態', value: `${EMOJI[result.status]} ${LABEL[result.status]}`, inline: true },
  ];
  if (result.price) fields.push({ name: '価格', value: result.price, inline: true });
  if (result.reason) fields.push({ name: '判定根拠', value: result.reason.slice(0, 1000) });

  return {
    title: result.status === IN_STOCK ? `🎮 在庫あり: ${result.name}` : `在庫が無くなりました: ${result.name}`,
    url: result.url,
    color: COLOR[result.status] ?? 0x3498db,
    description: productName ? `**${productName}**` : undefined,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'ps5pro-crawl' },
  };
}

export async function notifyStock(webhookUrl, { results, productName, mention }) {
  const inStock = results.filter((r) => r.status === IN_STOCK);
  const content = inStock.length
    ? [mention, `**${productName ?? 'PS5 Pro'}** の在庫を検知しました（${inStock.length}店舗）`]
        .filter(Boolean)
        .join(' ')
    : `**${productName ?? 'PS5 Pro'}** の在庫が無くなりました`;

  await post(webhookUrl, {
    content,
    embeds: results.slice(0, 10).map((r) => buildStockEmbed(r, productName)),
    allowed_mentions: mention ? undefined : { parse: [] },
  });
}

export async function notifyErrors(webhookUrl, { results, threshold }) {
  await post(webhookUrl, {
    content: `⚠️ ${threshold} 回以上連続で取得に失敗している販売店があります（セレクタ変更 / URL 変更 / ブロックの可能性）`,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: '取得エラーが継続中',
        color: COLOR[ERROR],
        fields: results.slice(0, 10).map((r) => ({
          name: r.name,
          value: `${r.consecutiveFailures} 回連続: ${(r.reason ?? '').slice(0, 200)}\n${r.url}`,
        })),
        timestamp: new Date().toISOString(),
        footer: { text: 'ps5pro-crawl' },
      },
    ],
  });
}

/** Webhook の疎通確認。設定直後に「本当に届くか」を在庫を待たずに確かめるため */
export async function notifyTest(webhookUrl, { productName, mention }) {
  await post(webhookUrl, {
    content: [mention, 'ps5pro-crawl の疎通テストです。これが見えていれば通知設定は正常です。']
      .filter(Boolean)
      .join(' '),
    allowed_mentions: mention ? undefined : { parse: [] },
    embeds: [
      {
        title: '✅ Webhook 疎通テスト',
        description: `監視対象: **${productName ?? 'PS5 Pro'}**\n在庫を検知するとこの形式で通知されます。`,
        color: 0x3498db,
        timestamp: new Date().toISOString(),
        footer: { text: 'ps5pro-crawl' },
      },
    ],
  });
}
