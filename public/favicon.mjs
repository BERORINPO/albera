// @ts-check
// 画面: 状態を示す favicon (wordmark と同じ 2×3 の棚)。返事待ちがあれば左上が青、止まったかもだけなら左中が墨。

/** CSS 変数を読めないので、light の値を固定で使う (design.md §3 の resolved light values)。 */
const PAPER = '#f0f8f7';
const INK = '#101b24';
const ACCENT = '#2e54ae';
const CELLS = Object.freeze([
  [1.5, 1.5],
  [8.5, 1.5],
  [1.5, 6.25],
  [8.5, 6.25],
  [1.5, 11],
  [8.5, 11],
]);

/**
 * @param {{needs_you?: number, trouble?: number}|null|undefined} counts
 * @returns {'needs'|'stuck'|'none'}
 */
export function faviconKind(counts) {
  if ((Number(counts?.needs_you) || 0) > 0) return 'needs';
  if ((Number(counts?.trouble) || 0) > 0) return 'stuck';
  return 'none';
}

/**
 * 16×16 の SVG の data URI。数字は入れない。
 * @param {'needs'|'stuck'|'none'} kind
 */
export function faviconHref(kind) {
  const cells = CELLS.map(([x, y], i) => {
    const on = (kind === 'needs' && i === 0) || (kind === 'stuck' && i === 2);
    const color = kind === 'needs' ? ACCENT : INK;
    const fill = on ? ` fill='${color}' stroke='${color}'` : '';
    return `<rect x='${x}' y='${y}' width='6' height='3.5'${fill}/>`;
  }).join('');
  const svgText = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='2.5' fill='${PAPER}'/><g fill='none' stroke='${INK}'>${cells}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svgText)}`;
}

let current = '';

/** 種類が変わったときだけ link の href を書き換える。 @param {'needs'|'stuck'|'none'} kind */
export function setFavicon(kind) {
  if (kind === current) return;
  const link = /** @type {HTMLLinkElement|null} */ (document.querySelector('link[rel="icon"]'));
  if (!link) return;
  link.href = faviconHref(kind);
  current = kind;
}
