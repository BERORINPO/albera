// @ts-check
// core: セッションがどのプロジェクトのものかを決める (純粋関数)。spec/board.md §8
// title や会話の中身からは推測しない。実際のフォルダを見た手掛かり (folders) は adapter が付ける。

import { CAP, OTHER_PROJECT, PROJECT_PARENT_MAX_DEPTH } from '../shared/constants.mjs';
import { parentOf } from './session.mjs';
import { cap } from './text.mjs';

/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */
/** @typedef {import('../shared/types.mjs').FolderHint} FolderHint */
/** @typedef {{key: string, name: string, extra: number, how: 'folder'|'pr'|'parent'|'other'}} ProjectRef */

const BS = '\\';
const WORKTREE_MARK = '\\.claude\\worktrees\\';

/** '/' を '\' に、前後の空白と末尾の '\' を外す。 @param {string} p */
export function normPath(p) {
  return String(p).replace(/\//g, BS).trim().replace(/\\+$/, '');
}

/** @param {string[]} roots */
export function normRoots(roots) {
  return roots.map((r) => normPath(r).toLowerCase()).filter((r) => r !== '');
}

/**
 * フォルダのパスからプロジェクト名を取り出す。決められなければ null。
 * @param {string|undefined} p
 * @param {string[]} roots normRoots 済み
 * @returns {string|null}
 */
export function folderSegment(p, roots) {
  if (!p) return null;
  let n = normPath(p);
  const wt = n.toLowerCase().indexOf(WORKTREE_MARK);
  if (wt >= 0) n = n.slice(0, wt);
  if (n === '' || /^[a-z]:$/i.test(n)) return null;
  const lower = n.toLowerCase();
  for (const r of roots) {
    if (lower === r) return null;
    if (lower.startsWith(r + BS)) return n.slice(r.length + 1).split(BS)[0] || null;
  }
  const parts = n.split(BS).filter((x) => x !== '');
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * 1 つのパスからプロジェクト名を決める。
 * hint が repo → その名前、container → このパスからは決めない (null)、hint なし → folderSegment (roots の規則)。
 * @param {string|undefined} p
 * @param {FolderHint|undefined} hint
 * @param {string[]} roots normRoots 済み
 * @returns {string|null}
 */
export function folderName(p, hint, roots) {
  if (hint?.kind === 'repo' && typeof hint.name === 'string' && hint.name.trim() !== '') return hint.name.trim();
  if (hint?.kind === 'container') return null;
  return folderSegment(p, roots);
}

/**
 * PR の repo の多数決。同数なら先頭の PR (prs[0]、無ければ旧形式の prRepository) の repo。
 * アプリも先頭の PR を主の PR として扱うため。'/' より後ろを名前にする。
 * @param {SessionRecord} s
 * @returns {{name: string, extra: number}|null}
 */
export function repoMajority(s) {
  const repos = [...(s.prs ?? []).map((p) => p.repo), s.prRepository].filter(
    (r) => typeof r === 'string' && r.trim() !== '',
  );
  if (!repos.length) return null;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const r of /** @type {string[]} */ (repos)) counts.set(r, (counts.get(r) ?? 0) + 1);
  let best = /** @type {string} */ (repos[0]);
  for (const [r, c] of counts) if (c > /** @type {number} */ (counts.get(best))) best = r; // Map は最初に出た順なので、同数なら先に出た方が残る
  const name = cap(best.slice(best.lastIndexOf('/') + 1) || best, CAP.TITLE);
  return { name, extra: counts.size - 1 };
}

/**
 * @param {{roots: string[], byId: Map<string, SessionRecord>}} opts roots は生のパス
 * @returns {(s: SessionRecord) => ProjectRef}
 */
export function createProjectResolver({ roots, byId }) {
  const nroots = normRoots(roots);
  /** @type {Map<string, ProjectRef|null>} */
  const memo = new Map();

  /** @param {SessionRecord} s @param {number} depth @param {Set<string>} visited @returns {ProjectRef|null} */
  function resolve(s, depth, visited) {
    if (memo.has(s.sessionId)) return /** @type {ProjectRef|null} */ (memo.get(s.sessionId));
    visited.add(s.sessionId);
    const seg = folderName(s.originCwd, s.folders?.origin, nroots) ?? folderName(s.cwd, s.folders?.cwd, nroots);
    const folder = seg ? cap(seg, CAP.TITLE) : null;
    /** @type {ProjectRef|null} */
    let ref = folder ? { key: folder.toLowerCase(), name: folder, extra: 0, how: 'folder' } : null;
    if (!ref) {
      const pr = repoMajority(s);
      if (pr) ref = { key: pr.name.toLowerCase(), name: pr.name, extra: pr.extra, how: 'pr' };
    }
    if (!ref && depth < PROJECT_PARENT_MAX_DEPTH) {
      const pid = parentOf(s);
      const parent = pid ? byId.get(pid) : undefined;
      if (parent && !visited.has(parent.sessionId)) {
        const pref = resolve(parent, depth + 1, visited);
        if (pref) ref = { ...pref, extra: 0, how: 'parent' }; // 「+N」は自分の PR の話なので継承しない
      }
    }
    if (depth === 0 || ref) memo.set(s.sessionId, ref);
    return ref;
  }

  // どれでも決まらなければ '(other)'。名前は空 (画面が「フォルダなし」と書く)
  return (s) => resolve(s, 0, new Set()) ?? { key: OTHER_PROJECT.key, name: '', extra: 0, how: 'other' };
}
