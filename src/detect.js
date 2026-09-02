import * as cheerio from 'cheerio';
import { IN_STOCK, OUT_OF_STOCK, UNKNOWN } from './status.js';

/** HTML からテキストを取り出す。selector 指定時は判定範囲を絞った文字列も返す */
export function extractText(html, selector) {
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg').remove();

  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const body = clean($('body').text());

  if (!selector) return { body, scope: body, scoped: false };

  const found = $(selector);
  if (found.length === 0) return { body, scope: body, scoped: false };
  return { body, scope: clean(found.text()), scoped: true };
}

function matchAny(text, patterns) {
  for (const p of patterns) {
    if (new RegExp(p, 'i').test(text)) return p;
  }
  return null;
}

/**
 * 判定順は「在庫なし」が先。
 * 「カートに入れる」等の文言は在庫切れページにも残っていることが多く、
 * 在庫ありを先に見ると誤通知になるため。
 */
export function detect(target, html) {
  const { body, scope, scoped } = extractText(html, target.selector);

  // ブロック判定とページ健全性チェックはページ全体で見る。
  // selector で絞ったテキストは数文字のことがあり、長さ判定に使えない。
  const blocked = matchAny(body, target.blockedPatterns ?? []);
  if (blocked) {
    return { status: UNKNOWN, reason: `ボット判定ページの可能性 (${blocked})`, text: body, scoped };
  }
  if (body.length < target.minTextLength) {
    return {
      status: UNKNOWN,
      reason: `ページ本文が短すぎます (${body.length} 文字) — ブロックまたはエラーページの可能性`,
      text: body,
      scoped,
    };
  }
  if (target.selector && !scoped) {
    return {
      status: UNKNOWN,
      reason: `セレクタ "${target.selector}" が 1 件も一致しませんでした — サイト改修の可能性`,
      text: body,
      scoped,
    };
  }

  const out = matchAny(scope, target.outOfStock);
  if (out) return { status: OUT_OF_STOCK, reason: `「${out}」に一致`, text: body, scoped };

  const inS = matchAny(scope, target.inStock);
  if (inS) return { status: IN_STOCK, reason: `「${inS}」に一致`, text: body, scoped };

  return { status: UNKNOWN, reason: '在庫あり/なしのどちらの文言にも一致せず', text: body, scoped };
}
