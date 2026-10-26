// @ts-check
// 画面: サーバーとの通信はこのファイルだけ (唯一の fetch 呼び出し元)。

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

/** A bounded, allowlisted worktree operation result. Never carries command output or paths. */
export class WorktreeOperationError extends Error {
  /** @param {number} status @param {string} reason */
  constructor(status, reason) {
    super(`worktree operation ${status}: ${reason}`);
    this.name = 'WorktreeOperationError';
    this.status = status;
    this.reason = reason;
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

/** Send one explicit, same-origin create request; browser input contains only an opaque session ID and branch label.
 * @param {string} sessionId @param {string} branch
 * @returns {Promise<{branch:string,status:string,changed:number,untracked:number,conflicted:number}>}
 */
export async function createWorktree(sessionId, branch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 65_000);
  try {
    const res = await fetch('/api/worktrees', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, branch }), cache: 'no-store', credentials: 'same-origin', signal: ctl.signal,
    });
    let data = {};
    try { data = await res.json(); } catch { /* generic error below */ }
    if (!res.ok || data?.ok !== true || typeof data.branch !== 'string') {
      throw new WorktreeOperationError(res.status, typeof data?.reason === 'string' ? data.reason : 'failed');
    }
    return {
      branch: data.branch,
      status: ['clean', 'changed', 'untracked', 'mixed', 'conflicted', 'unknown'].includes(data.status) ? data.status : 'unknown',
      changed: Number.isSafeInteger(data.changed) && data.changed >= 0 ? data.changed : 0,
      untracked: Number.isSafeInteger(data.untracked) && data.untracked >= 0 ? data.untracked : 0,
      conflicted: Number.isSafeInteger(data.conflicted) && data.conflicted >= 0 ? data.conflicted : 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch bounded path-free worktree summaries for one selected session's repository.
 * @param {string} sessionId
 * @returns {Promise<Array<{branch:string|null,status:string,changed:number,untracked:number,conflicted:number,detached:boolean,locked:boolean,prunable:boolean,current:boolean}>>}
 */
export async function listWorktrees(sessionId) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(`/api/worktrees?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
    let data = {};
    try { data = await res.json(); } catch { /* generic error below */ }
    if (!res.ok || !Array.isArray(data?.items)) throw new WorktreeOperationError(res.status, typeof data?.error === 'string' ? data.error : 'failed');
    return data.items.slice(0, 20).map((item) => ({
      branch: typeof item?.branch === 'string' ? item.branch : null,
      status: ['clean', 'changed', 'untracked', 'mixed', 'conflicted', 'unknown'].includes(item?.status) ? item.status : 'unknown',
      changed: Number.isSafeInteger(item?.changed) && item.changed >= 0 ? item.changed : 0,
      untracked: Number.isSafeInteger(item?.untracked) && item.untracked >= 0 ? item.untracked : 0,
      conflicted: Number.isSafeInteger(item?.conflicted) && item.conflicted >= 0 ? item.conflicted : 0,
      detached: item?.detached === true, locked: item?.locked === true, prunable: item?.prunable === true, current: item?.current === true,
    }));
  } finally {
    clearTimeout(timer);
  }
}
