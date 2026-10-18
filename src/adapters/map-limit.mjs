// @ts-check
// adapter 共通: 配列を同時に n 件ずつ非同期処理する (大量のファイルを一度に開かないため)。

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} n
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, n, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
