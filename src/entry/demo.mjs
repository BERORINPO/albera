// @ts-check
// entry: デモ (`--demo`) の adapter の組。合成データ (adapters/demo-data.mjs) を Fake に入れて返す。

import { DEMO_REBUILD_MS } from '../shared/constants.mjs';
import { buildDemo } from '../adapters/demo-data.mjs';
import { createFakeAppSessionsSource } from '../adapters/fake-app-sessions.mjs';
import { createFakeCopilotSessionsSource } from '../adapters/fake-copilot-sessions.mjs';
import { createFakeFolderHints } from '../adapters/fake-folder-hints.mjs';
import { createFakeTranscriptsSource } from '../adapters/fake-transcripts.mjs';
import { createFakeWorktreeSource } from '../adapters/fake-worktrees.mjs';
import { createFakeWorktreeCreator } from '../adapters/fake-worktree-create.mjs';
import { createFakeWorktreeRemover } from '../adapters/fake-worktree-remove.mjs';

/**
 * デモの合成データを DEMO_REBUILD_MS ごとに今の時刻から作り直す Fake の組。
 * 起動時に 1 回だけ作ると、時間が経つにつれ作業中の行が止まったかもへ移り、経過時間もずれていく。ID は毎回同じ。
 * @param {import('../shared/types.mjs').Lang} lang
 * @param {() => number} [clock]
 */
export function liveDemoSources(lang, clock = () => Date.now()) {
  /** @type {{at: number, sessions: ReturnType<typeof createFakeAppSessionsSource>, transcripts: ReturnType<typeof createFakeTranscriptsSource>, hints: ReturnType<typeof createFakeFolderHints>}|null} */
  let built = null;
  const current = () => {
    const now = clock();
    if (!built || now - built.at >= DEMO_REBUILD_MS) {
      const demo = buildDemo(now, lang);
      const demoFolders = [...new Set(demo.raws.map((r) => r.cwd).filter((cwd) => typeof cwd === 'string' && cwd))];
      built = {
        at: now,
        sessions: createFakeAppSessionsSource({ raws: demo.raws, archivedIds: demo.archivedIds }),
        copilot: createFakeCopilotSessionsSource({ sessions: [{
          source: 'copilot', sessionId: 'copilot_00000000-0000-4000-8000-000000000901',
          title: 'GitHub Copilot', cwd: demoFolders[0], createdAt: now - 2 * 60_000,
          lastActivityAt: now - 60_000, lastFocusedAt: now - 60_000,
          isArchived: false, isStarred: false, autoArchiveExempt: true, prs: [],
          pendingFirstStart: null, lifecycle: { status: 'active', startedAt: now - 60_000 },
          events: [{ type: 'turn_started', at: now - 60_000 }],
        }] }),
        transcripts: createFakeTranscriptsSource(demo.transcripts),
        hints: createFakeFolderHints(demo.folderHints),
        worktrees: createFakeWorktreeSource(Object.fromEntries(demoFolders.map((cwd, i) => {
          const status = ['changed', 'untracked', 'mixed', 'clean'][i % 4];
          return [cwd, {
            branch: i % 4 === 0 ? 'demo/canvas-check' : 'demo/main',
            status, changed: status === 'changed' || status === 'mixed' ? 2 : 0,
            untracked: status === 'untracked' || status === 'mixed' ? 1 : 0,
            conflicted: 0, locked: i === 0, prunable: i === 1,
          }];
        }))),
      };
    }
    return built;
  };
  return {
    sessionsSource: { load: async () => {
      const [claude, copilot] = await Promise.all([current().sessions.load(), current().copilot.load()]);
      return {
        sessions: [...claude.sessions, ...copilot.sessions],
        archivedIds: claude.archivedIds,
        stats: { ...claude.stats, sources: { copilot: copilot.stats } },
      };
    } },
    transcriptsSource: { read: (/** @type {string[]} */ ids) => current().transcripts.read(ids), stats: () => current().transcripts.stats() },
    folderHints: { hintFor: (/** @type {string} */ p) => current().hints.hintFor(p) },
    worktreeSource: {
      enrich: (/** @type {import('../shared/types.mjs').SessionRecord[]} */ sessions) => current().worktrees.enrich(sessions),
      listForCwd: (/** @type {string} */ cwd) => current().worktrees.listForCwd(cwd),
      stats: () => current().worktrees.stats(),
    },
    worktreeCreator: createFakeWorktreeCreator(),
    worktreeRemover: createFakeWorktreeRemover(),
  };
}
