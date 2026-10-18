// @ts-check
// adapter: セッションのフォルダ (originCwd / cwd) を実際に見て、プロジェクト判定の手掛かり (FolderHint) を返す。
// 見るのは stat と readdir だけ (書き込まない)。結果はパスごとに FOLDER_HINT_TTL_MS キャッシュする。spec/board.md §4
//   repo      = そのパスか上 FOLDER_WALK_MAX 階層までのどこかに .git がある (name = そのフォルダ名)
//   container = repo の中ではなく、home そのもの、または直下に .git を持つフォルダが 2 つ以上ある
//   なし      = それ以外 (パスがもう無い場合も)。core は今までの roots の規則に戻る
// ネットワークのパス (\\server\share・//server/share) は見ない (SMB の接続を作らない・届かない共有で止まらない)。
// 1 つのパスの判定は FOLDER_HINT_TIMEOUT_MS までしか待たない (割り当てたネットワークドライブが届かないときも盤面を止めない)。

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CAP,
  FOLDER_CHILD_SCAN_MAX,
  FOLDER_HINT_CACHE_MAX,
  FOLDER_HINT_TIMEOUT_MS,
  FOLDER_HINT_TTL_MS,
  FOLDER_WALK_MAX,
  READ_CONCURRENCY,
} from '../shared/constants.mjs';
import { cap } from '../core/text.mjs';
import { cutWorktreeTail } from './session-record.mjs';

/** @typedef {import('../shared/types.mjs').FolderHint} FolderHint */

const REPOS_FOR_CONTAINER = 2;
const NETWORK_PATH_RE = /^[\\/]{2}/;

/** ms 後に undefined で終わる (プロセスの終了は待たせない)。 @param {number} ms @returns {Promise<undefined>} */
const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
  });

/** @param {string} p */
async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * .git はファイル (worktree・submodule) でもフォルダでもよい。フォルダのときは HEAD があるものだけ数える
 * (中身の壊れた .git が残っているフォルダを、全体で 1 つの repo と見なさないため)。
 * @param {string} dir
 */
async function hasGit(dir) {
  const dotGit = path.join(dir, '.git');
  try {
    const st = await fs.stat(dotGit);
    if (st.isFile()) return true;
    if (!st.isDirectory()) return false;
    await fs.stat(path.join(dotGit, 'HEAD'));
    return true;
  } catch {
    return false;
  }
}

/** 直下の子フォルダ (dotfile を除く、先頭 FOLDER_CHILD_SCAN_MAX 個) のうち .git を持つものの数。2 つ見つかれば打ち切る。 @param {string} dir */
async function repoChildren(dir) {
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const kids = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).slice(0, FOLDER_CHILD_SCAN_MAX);
  let n = 0;
  for (let i = 0; i < kids.length && n < REPOS_FOR_CONTAINER; i += READ_CONCURRENCY) {
    const found = await Promise.all(kids.slice(i, i + READ_CONCURRENCY).map((e) => hasGit(path.join(dir, e.name))));
    n += found.filter(Boolean).length;
  }
  return n;
}

/**
 * @param {{home: string, ttlMs?: number, maxEntries?: number, clock?: () => number, caseInsensitive?: boolean,
 *   timeoutMs?: number, wait?: (ms: number) => Promise<undefined>}} opts
 *   caseInsensitive: パスの比較で大文字小文字を区別しない (Windows と macOS の既定)。wait はテスト用 (待ち時間の作り方)
 */
export function createFolderHints({
  home,
  ttlMs = FOLDER_HINT_TTL_MS,
  maxEntries = FOLDER_HINT_CACHE_MAX,
  clock = () => Date.now(),
  caseInsensitive = process.platform === 'win32' || process.platform === 'darwin',
  timeoutMs = FOLDER_HINT_TIMEOUT_MS,
  wait = sleep,
}) {
  const keyOf = (/** @type {string} */ p) => (caseInsensitive ? p.toLowerCase() : p);
  const homeKey = keyOf(path.resolve(home));
  const isHome = (/** @type {string} */ d) => keyOf(d) === homeKey;
  const isRoot = (/** @type {string} */ d) => path.dirname(d) === d;
  /** @type {Map<string, {at: number, value: Promise<FolderHint|undefined>}>} 古いものが先頭 (Map は入れた順) */
  const cache = new Map();

  /** @param {string} dir 絶対パス (worktree を切ったもの) @returns {Promise<FolderHint|undefined>} */
  async function compute(dir) {
    if (!(await isDir(dir))) return undefined;
    let d = dir;
    for (let i = 0; i <= FOLDER_WALK_MAX; i++) {
      // home 自体は repo にしない (dotfiles の repo があっても全部が 1 プロジェクトにならないように)。ドライブ直下・ルートも見ない
      if (isHome(d) || isRoot(d)) break;
      if (await hasGit(d)) return { kind: 'repo', name: cap(path.basename(d), CAP.TITLE) };
      d = path.dirname(d);
    }
    if (isHome(dir)) return { kind: 'container' };
    return (await repoChildren(dir)) >= REPOS_FOR_CONTAINER ? { kind: 'container' } : undefined;
  }

  return {
    /**
     * @param {string} raw セッションの cwd / originCwd (アプリの JSON のまま)
     * @returns {Promise<FolderHint|undefined>}
     */
    hintFor(raw) {
      if (typeof raw !== 'string') return Promise.resolve(undefined);
      const cut = cutWorktreeTail(raw.trim());
      if (cut === '' || !path.isAbsolute(cut) || NETWORK_PATH_RE.test(cut)) return Promise.resolve(undefined);
      const dir = path.resolve(cut);
      const key = keyOf(dir);
      const now = clock();
      const hit = cache.get(key);
      if (hit && now - hit.at < ttlMs) return hit.value;
      const value = Promise.race([compute(dir).catch(() => undefined), wait(timeoutMs)]);
      cache.delete(key);
      cache.set(key, { at: now, value });
      while (cache.size > maxEntries) cache.delete(/** @type {string} */ (cache.keys().next().value));
      return value;
    },
    /** テストと観測用 */
    size() {
      return cache.size;
    },
  };
}
