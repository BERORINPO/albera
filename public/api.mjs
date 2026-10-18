// @ts-check
// 画面: サーバーとの通信はこのファイルだけ (唯一の fetch 呼び出し元)。GET /api/board しかしない。

/** サーバーには繋がったが、盤面を返せなかった (5xx など)。繋がらないときの TypeError / AbortError とは分ける。 */
export class BoardHttpError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`HTTP ${status}`);
    this.name = 'BoardHttpError';
    this.status = status;
  }
}

/** 盤面の版が違う (サーバーが新しくなった)。再読み込みしてもらう。 */
export class BoardVersionError extends Error {
  /** @param {unknown} v */
  constructor(v) {
    super(`board version ${String(v)}`);
    this.name = 'BoardVersionError';
    this.v = v;
  }
}

/**
 * 盤面を取得する。変わっていなければ 304。
 * @param {string|null} etag
 * @param {number} timeoutMs
 * @returns {Promise<{status: 200, etag: string|null, data: any} | {status: 304}>}
 */
export async function fetchBoard(etag, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    /** @type {Record<string, string>} */
    const headers = etag ? { 'If-None-Match': etag } : {};
    const res = await fetch('/api/board', { headers, cache: 'no-store', signal: ctl.signal });
    if (res.status === 304) return { status: 304 };
    if (!res.ok) throw new BoardHttpError(res.status);
    const data = await res.json();
    if (!data || data.v !== 2 || typeof data.counts !== 'object' || data.counts === null) throw new BoardVersionError(data?.v);
    return { status: 200, etag: res.headers.get('ETag'), data };
  } finally {
    clearTimeout(timer);
  }
}
