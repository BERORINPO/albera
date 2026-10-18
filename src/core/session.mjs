// @ts-check
// core: 1 セッションについての小さな読み出し (純粋関数)。

import { SESSION_ID_RE } from '../shared/constants.mjs';

/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */

/** 最後に動いた時刻。lastActivityAt が無ければ createdAt。 @param {SessionRecord} s */
export const activityOf = (s) => s.lastActivityAt ?? s.createdAt ?? 0;

/** @param {string|undefined} id */
const asSessionId = (id) => (typeof id === 'string' && SESSION_ID_RE.test(id) ? id : undefined);

/**
 * 親セッションの ID (無ければ null)。セッション ID の形 (local_<uuid>) に合うものだけを親とみなす。
 * dispatchParentId の 'local_ditto_<orgUuid>' のような擬似 ID はセッションではないので親にしない。
 * @param {SessionRecord} s
 */
export const parentOf = (s) => asSessionId(s.spawnedFromId) ?? asSessionId(s.forkedFromSessionId) ?? asSessionId(s.dispatchParentId) ?? null;

/**
 * prs[] と旧形式の prNumber / prRepository / prState をまとめる (同じ番号は重ねない)。
 * @param {SessionRecord} s
 * @returns {Array<{num: number, repo: string, state: string, url: string}>}
 */
export function prListOf(s) {
  const out = [];
  const seen = new Set();
  for (const p of s.prs ?? []) {
    if (typeof p.prNumber !== 'number') continue;
    const key = `${p.repo ?? ''}#${p.prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ num: p.prNumber, repo: p.repo ?? '', state: p.state ?? '', url: p.url ?? '' });
  }
  if (typeof s.prNumber === 'number' && !out.some((p) => p.num === s.prNumber)) {
    out.push({ num: s.prNumber, repo: s.prRepository ?? '', state: s.prState ?? '', url: s.prUrl ?? '' });
  }
  return out;
}

/**
 * 親をたどった根 (循環と深さを止める)。親が見つからなければそこで止まる。
 * @param {SessionRecord} s
 * @param {Map<string, SessionRecord>} byId
 * @param {number} maxDepth
 * @returns {SessionRecord}
 */
export function rootOf(s, byId, maxDepth) {
  let cur = s;
  const visited = new Set([s.sessionId]);
  for (let d = 0; d < maxDepth; d++) {
    const pid = parentOf(cur);
    const parent = pid ? byId.get(pid) : undefined;
    if (!parent || visited.has(parent.sessionId)) break;
    visited.add(parent.sessionId);
    cur = parent;
  }
  return cur;
}
