// テスト用の合成データ (実際のセッションの中身・パス・ID は使わない)。
// core のテストが adapter のデモデータに依存しないよう、ID と会話ログの行もここで作る。
import { toSessionRecord } from '../../src/adapters/session-record.mjs';

export const NOW = Date.UTC(2026, 9, 17, 11, 0, 0);
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
// 合成の roots (Windows 形式と POSIX 形式の両方)
export const ROOTS = ['C:\\work', 'D:\\code', '/home/tester'];

/** @param {number} n */
export const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
/** @param {number} n */
export const sid = (n) => `local_${uuid(n)}`;
/** @param {number} n */
export const cid = (n) => uuid(100000 + n);

/**
 * 合成のアプリ JSON を作って SessionRecord にする。
 * @param {number} n
 * @param {Record<string, unknown>} fields
 */
export function rec(n, fields = {}) {
  const r = toSessionRecord({
    sessionId: sid(n),
    cliSessionId: cid(n),
    title: `テスト ${n}`,
    cwd: 'C:\\work\\alpha',
    originCwd: 'C:\\work\\alpha',
    createdAt: NOW - 2 * HOUR,
    lastActivityAt: NOW - HOUR,
    lastFocusedAt: NOW - HOUR + 10 * SEC,
    isArchived: false,
    ...fields,
  });
  if (!r) throw new Error('fixture の ID が不正');
  return r;
}

/**
 * 会話ログの入力。
 * @param {string} tail
 * @param {number} mainAgo
 * @param {number} [subAgo] 無ければ subagents なし
 */
export function ti(tail, mainAgo, subAgo) {
  return { tail, truncatedHead: false, mainMtime: NOW - mainAgo, subMtime: subAgo == null ? 0 : NOW - subAgo, size: tail.length };
}

/**
 * JSON 1 行。at を渡すと "timestamp" (ISO 文字列) を付ける。
 * @param {Record<string, unknown>} obj
 * @param {number} [at]
 */
const line = (obj, at) => JSON.stringify(at == null ? obj : { ...obj, timestamp: new Date(at).toISOString() });
const user = (/** @type {unknown} */ content, /** @type {number|undefined} */ at, extra = {}) => line({ type: 'user', ...extra, message: { role: 'user', content } }, at);
const assistant = (/** @type {unknown[]} */ content, /** @type {string} */ stop, /** @type {number|undefined} */ at) =>
  line({ type: 'assistant', message: { role: 'assistant', content, stop_reason: stop } }, at);

/** 会話ログ (jsonl) の合成行。最後の引数 at は "timestamp" (省略可)。 */
export const synth = {
  prompt: (/** @type {string} */ text, /** @type {number=} */ at) => user(text, at),
  text: (/** @type {string} */ text, stop = 'end_turn', /** @type {number=} */ at) => assistant([{ type: 'text', text }], stop, at),
  toolUse: (/** @type {number=} */ at) => assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 'tool_use', at),
  toolResult: (/** @type {number=} */ at) => user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], at),
  /** 利用者に質問するツール (AskUserQuestion / ExitPlanMode) の呼び出し。question が '' なら質問文なし */
  ask: (/** @type {string} */ id, /** @type {string} */ question, name = 'AskUserQuestion', /** @type {number=} */ at) =>
    assistant(
      [{ type: 'tool_use', id, name, input: name === 'AskUserQuestion' ? { questions: [{ question, header: 'h', options: [] }] } : { plan: question } }],
      'tool_use',
      at,
    ),
  toolUseId: (/** @type {string} */ id, name = 'Bash') => assistant([{ type: 'tool_use', id, name, input: {} }], 'tool_use'),
  resultFor: (/** @type {string} */ id) => user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]),
  stopHook: () => line({ type: 'system', subtype: 'stop_hook_summary' }),
  otherSystem: () => line({ type: 'system', subtype: 'compact_boundary' }),
  notification: (/** @type {number=} */ at) => user('<task-notification>終わりました</task-notification>', at),
  reminder: (/** @type {number=} */ at) => user([{ type: 'text', text: '<system-reminder>メモ</system-reminder>' }], at),
  interrupted: (/** @type {number=} */ at) => user([{ type: 'text', text: '[Request interrupted by user]' }], at),
  meta: (/** @type {number=} */ at) => user('meta', at, { isMeta: true }),
  commandName: (/** @type {number=} */ at) => user('<command-name>/model</command-name>', at),
  commandStdout: (/** @type {number=} */ at) => user('<local-command-stdout>ok</local-command-stdout>', at),
  noise: () => line({ type: 'file-history-snapshot', snapshot: {} }),
};

/** よく使う会話ログの末尾。 */
export const tails = {
  ended: () => [synth.prompt('進めてください'), synth.toolUse(), synth.toolResult(), synth.text('終わりました'), synth.stopHook(), ''].join('\n'),
  tool: (/** @type {number=} */ startedAt) => [synth.prompt('調べてください', startedAt), synth.toolUse(), ''].join('\n'),
  toolResult: () => [synth.prompt('調べてください'), synth.toolUse(), synth.toolResult(), ''].join('\n'),
  prompt: (/** @type {number=} */ startedAt) => [synth.text('どうしますか'), synth.stopHook(), synth.prompt('こちらでお願いします', startedAt), ''].join('\n'),
  asking: (question = 'どちらの案で進めますか?', name = 'AskUserQuestion') =>
    [synth.prompt('進めてください'), synth.toolUse(), synth.toolResult(), synth.ask('q1', question, name), ''].join('\n'),
};
