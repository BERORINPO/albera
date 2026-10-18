// @ts-check
// core: 文字列の整形 (純粋関数)。

/**
 * code point 単位で n 文字以内に切る。切ったときは末尾を「…」にする。
 * @param {unknown} value
 * @param {number} n
 * @returns {string}
 */
export function cap(value, n) {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length <= n) return value; // UTF-16 長が n 以下なら code point も n 以下
  const points = Array.from(value);
  if (points.length <= n) return value;
  return points.slice(0, Math.max(0, n - 1)).join('') + '…';
}

/** @param {unknown} v */
export const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * lastTurnReport ("<要約> ⏎ <最後のメッセージ>") から要約部分を取り出す。
 * 前後の " と \" を外し、⏎ より前を取り、[t](u) を t にして、空白を詰める。
 * @param {unknown} report
 * @returns {string}
 */
export function reportSummary(report) {
  if (typeof report !== 'string') return '';
  let t = report.trim();
  t = t.replace(/^(\\?")+/, '').replace(/(\\?")+$/, '');
  const cut = t.indexOf('⏎');
  if (cut >= 0) t = t.slice(0, cut);
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\*\*/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * エラー文から使用上限の解除時刻の部分 ("resets 1:50pm") を取り出す。
 * @param {string} error
 * @returns {string}
 */
export function resetPart(error) {
  const m = error.match(/resets?\s.+$/);
  return m ? m[0].trim() : '';
}
