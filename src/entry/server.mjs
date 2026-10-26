#!/usr/bin/env node
// @ts-check
// entry: 起動 (CLI)。設定の検証 → adapter の選択 (実データ / デモ) → 127.0.0.1 だけで待ち受け。spec/board.md §11
//   npx pigeonholes / npm start      実データ。セッションデータは読み取り専用、worktreeは確認後
//   npm run demo (--demo)            合成データ。worktree作成は無効
// 端末の言葉は messages.mjs。ログに title や本文は書かない。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, PRODUCT } from '../shared/constants.mjs';
import { createAppSessionsSource } from '../adapters/app-sessions-fs.mjs';
import { createCodexSessionsSource } from '../adapters/codex-sessions-fs.mjs';
import { createCopilotSessionsSource } from '../adapters/copilot-sessions-fs.mjs';
import { createOpenCodeSessionsSource } from '../adapters/opencode-sessions-fs.mjs';
import { createFolderHints } from '../adapters/folder-hints-fs.mjs';
import { createTranscriptsSource } from '../adapters/transcripts-fs.mjs';
import { createWorktreeSource } from '../adapters/worktrees-git.mjs';
import { createWorktreeCreator } from '../adapters/worktree-create-git.mjs';
import { createWorktreeRemover } from '../adapters/worktree-remove-git.mjs';
import { createCodexDelegationRunner } from '../adapters/codex-delegation-runner.mjs';
import { wslCwdToUnc, wslShareRoot } from '../adapters/wsl-paths.mjs';
import { argsWithoutPort, ConfigError, loadConfig, portHint, shellQuote } from './config.mjs';
import { liveDemoSources } from './demo.mjs';
import { createHandler } from './http.mjs';
import { errorLines, msg } from './messages.mjs';
import { probeBoard } from './probe.mjs';
import { createBoardService } from './service.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const PACKAGE_JSON = path.join(path.dirname(SELF_PATH), '..', '..', 'package.json');
const SESSION_CARD_ID = /^(?:local|codex|copilot|opencode)_[0-9a-f-]{36}$/i;

/** package.json の version (読めなければ 0.0.0)。 */
function readVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 案内に出す起動のしかた。npm で入れたなら bin 名、clone から動かしているならこのファイルの絶対パス (どのフォルダからでも打てる)。 */
function launcher() {
  if (/[\\/]node_modules[\\/]/.test(SELF_PATH)) return `npx ${PRODUCT.bin}`;
  return `node ${shellQuote(SELF_PATH.replaceAll('\\', '/'), process.platform)}`;
}

/** @param {import('./config.mjs').RunConfig} config */
function wire(config) {
  if (config.demo) return liveDemoSources(config.lang);
  const codexWslRoot = process.platform === 'win32' ? wslShareRoot(config.codexHome) : '';
  const codexWslShareStatus = process.platform !== 'win32' ? 'not_applicable' : codexWslRoot ? 'configured' : 'not_configured';
  const sessionsSource = createCombinedSessionsSource([
    createAppSessionsSource({ root: config.sessionsRoot }),
    createCodexSessionsSource({ root: config.codexHome, cwdMapper: codexWslRoot ? (cwd) => wslCwdToUnc(cwd, codexWslRoot) : undefined, wslShareStatus: codexWslShareStatus }),
    createCopilotSessionsSource({ root: config.copilotHome }),
    createOpenCodeSessionsSource({ root: config.openCodeDb }),
  ]);
  return {
    sessionsSource,
    transcriptsSource: createTranscriptsSource({ projectsDir: config.projectsDir }),
    folderHints: createFolderHints({ home: config.home, wslShareRoot: codexWslRoot }),
    worktreeSource: createWorktreeSource(),
    worktreeCreator: createWorktreeCreator(),
    worktreeRemover: createWorktreeRemover(),
  };
}

/** @param {Array<{load: () => Promise<{sessions:any[],archivedIds:Set<string>,stats:any}>}>} sources */
function createCombinedSessionsSource(sources) {
  return {
    async load() {
      const loaded = await Promise.all(sources.map((source) => source.load()));
      // 既存の診断統計は Claude セッション源の値をそのまま使う。
      const claudeStats = loaded[0]?.stats ?? { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0 };
      const codexStats = loaded[1]?.stats ?? { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0, wslShareStatus: 'not_applicable' };
      const copilotStats = loaded[2]?.stats ?? { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0 };
      const opencodeStats = loaded[3]?.stats ?? { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0 };
      const stats = { ...claudeStats, sources: { codex: codexStats, copilot: copilotStats, opencode: opencodeStats } };
      return {
        sessions: loaded.flatMap((source) => source.sessions),
        archivedIds: new Set(loaded.flatMap((source) => [...source.archivedIds])),
        stats,
      };
    },
  };
}

/** @param {string[]} lines */
const printErr = (lines) => {
  for (const l of lines) console.error(l);
};

function main() {
  let loaded;
  try {
    loaded = loadConfig({
      env: process.env,
      argv: process.argv.slice(2),
      home: os.homedir(),
      cwd: process.cwd(),
      platform: process.platform,
      intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    });
  } catch (e) {
    if (e instanceof ConfigError) {
      printErr(errorLines(e.lang, e.key, { cmd: launcher(), ...e.params }));
      process.exit(1);
    }
    throw e;
  }
  const { lang } = loaded;
  if (loaded.action === 'help') {
    console.log(msg(lang, 'term.help', { version: readVersion(), port: DEFAULT_PORT, sep: path.delimiter, cmd: launcher() }));
    return;
  }
  if (loaded.action === 'version') {
    console.log(msg(lang, 'term.version', { version: readVersion() }));
    return;
  }
  const config = loaded;
  const { port } = config;
  const sources = wire(config);
  const delegationRunner = config.demo ? null : createCodexDelegationRunner();
  const service = createBoardService({ ...sources, roots: config.roots, demo: config.demo });
  const activeSessionForId = async (sessionId) => {
    if (!SESSION_CARD_ID.test(sessionId)) return { ok: false, reason: 'invalid_target' };
    const loadedSessions = await sources.sessionsSource.load();
    const session = loadedSessions.sessions.find((item) => item.sessionId === sessionId);
    if (!session || session.isArchived || loadedSessions.archivedIds.has(sessionId) || !session.cwd) return { ok: false, reason: 'invalid_target' };
    return session;
  };
  const createWorktree = async (sessionId, branch) => {
    const session = await activeSessionForId(sessionId);
    if (session?.executionLocation === 'wsl') return { ok: false, reason: 'unsupported_location' };
    return session?.cwd ? sources.worktreeCreator.create({ cwd: session.cwd, branch }) : session;
  };
  const listWorktrees = async (sessionId) => {
    const session = await activeSessionForId(sessionId);
    if (session?.executionLocation === 'wsl') return { ok: false, reason: 'unsupported_location' };
    return session?.cwd ? sources.worktreeSource.listForCwd(session.cwd) : session;
  };
  const removeWorktree = async (sessionId, branch, confirmed) => {
    const session = await activeSessionForId(sessionId);
    if (session?.executionLocation === 'wsl') return { ok: false, reason: 'unsupported_location' };
    return session?.cwd ? sources.worktreeRemover.remove({ cwd: session.cwd, branch, confirmed }) : session;
  };
  const startDelegation = async (sessionId, purpose, confirmed, operationId) => {
    const session = await activeSessionForId(sessionId);
    if (session?.ok === false || session?.source !== 'codex' || !session.cliSessionId || !session.cwd) return { ok: false, reason: 'invalid_target' };
    if (session.executionLocation === 'wsl') return { ok: false, reason: 'unsupported_location' };
    if (session.lifecycle?.status === 'active') return { ok: false, reason: 'session_active' };
    if (session.lifecycle?.status !== 'complete') return { ok: false, reason: 'session_unknown' };
    return delegationRunner?.start({ sessionId: session.cliSessionId, cwd: session.cwd, purpose, confirmed, operationId }) ?? { ok: false, reason: 'unavailable' };
  };
  const handler = createHandler({ port, getBoard: () => service.get(), createWorktree, listWorktrees, removeWorktree, startDelegation, getDelegationStatus: (id) => delegationRunner?.status(id), demo: config.demo, log: (key, params) => console.error(msg(lang, key, params)) });
  const server = http.createServer(handler);
  server.on('error', async (/** @type {NodeJS.ErrnoException} */ e) => {
    if (e.code === 'EADDRINUSE') {
      // 起動例には付けていたフラグを残す (--demo を落として実データを開かせない)
      const { cmd } = portHint(process.platform, port, launcher(), argsWithoutPort(process.argv.slice(2)));
      const running = await probeBoard(port);
      if (running === (config.demo ? 'demo' : 'live')) {
        // 応答は真似できるので、自分で起動していなければ別の番号で、と添える
        console.log(msg(lang, 'term.alreadyRunning', { port }));
        console.log(msg(lang, 'term.alreadyRunningCheck', { cmd }));
        process.exit(0);
      }
      if (running) printErr([msg(lang, running === 'demo' ? 'term.runningDemo' : 'term.runningLive', { port, cmd })]);
      else printErr([msg(lang, 'term.portBusy', { port, cmd })]);
    } else {
      printErr([msg(lang, 'term.cantStart', { code: e.code ?? e.message })]);
    }
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(msg(lang, 'term.started', { port, mode: msg(lang, config.demo ? 'term.modeDemo' : 'term.modeReadOnly') }));
    service.get().catch(() => {}); // 初回の全件スキャン (約 3 秒) を先に済ませておく
  });
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
