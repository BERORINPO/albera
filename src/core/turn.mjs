// @ts-check
// core: 会話ログの末尾からターンの状態を判定する (純粋関数)。spec/board.md §5

import { ASK_TOOLS, CAP } from '../shared/constants.mjs';
import { cap } from './text.mjs';

/** @typedef {import('../shared/types.mjs').TurnResult} TurnResult */
/** @typedef {import('../shared/types.mjs').AskKind} AskKind */

const TURN_TYPES = new Set(['user', 'assistant', 'system']);
const ENDED_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);
// ターンの区切りにはならない (読み飛ばす) user 行の先頭
const PASSIVE_USER_PREFIXES = ['<task-notification', '<system-reminder', '<local-command-stdout', '<local-command-caveat', '<command-name', '<command-message'];
/**
 * 末尾テキストを行に分け、type が user / assistant / system の JSON 行だけ返す。
 * @param {string} tailText
 * @param {boolean} truncatedHead 先頭行が途中から始まっているなら捨てる
 * @returns {any[]}
 */
export function turnEntries(tailText, truncatedHead) {
  const lines = String(tailText ?? '').split('\n');
  if (truncatedHead) lines.shift();
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed[0] !== '{') continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry && TURN_TYPES.has(entry.type)) out.push(entry);
  }
  return out;
}

/** @param {unknown} content */
function firstText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
    }
  }
  return '';
}

/** @param {unknown} content */
function hasToolResult(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
}

/**
 * user 行を 1 つ判定する。決まらない (読み飛ばす) ときは null。
 * @param {any} entry
 * @param {{skipCmd: boolean}} st
 * @returns {Omit<TurnResult, 'relevant'>|null}
 */
function judgeUser(entry, st) {
  if (entry.isMeta === true) return null;
  const content = entry.message?.content;
  if (hasToolResult(content)) return { turn: 'inprogress', lastKind: 'tool' };
  const text = firstText(content).trimStart();
  if (text.startsWith('<local-command-stdout') || text.startsWith('<local-command-caveat')) {
    st.skipCmd = true;
    return null;
  }
  if (st.skipCmd && (text.startsWith('<command-name') || text.startsWith('<command-message'))) return null;
  st.skipCmd = false;
  if (text.startsWith('<task-notification') || text.startsWith('<system-reminder')) return null;
  if (text.startsWith('[Request interrupted')) return { turn: 'ended', how: 'interrupted' };
  return { turn: 'inprogress', lastKind: 'prompt' };
}

/**
 * 質問ツールの入力から質問文とツールの種類を取り出す。決まり文句は入れない (言葉は画面が持つ)。
 * @param {string} name
 * @param {any} input
 * @returns {{question: string, kind: AskKind}}
 */
function askOf(name, input) {
  const q = Array.isArray(input?.questions) ? input.questions[0]?.question : undefined;
  const question = typeof q === 'string' && q.trim() !== '' ? cap(q.trim(), CAP.BODY) : '';
  return { question, kind: name === 'ExitPlanMode' ? 'plan' : 'question' };
}

/**
 * 今のターンで、返事を待っている質問ツール (AskUserQuestion / ExitPlanMode) を探す。
 * 後ろからターンの区切り (指示・中断・stop_hook_summary・end_turn) までを見て、
 * tool_result がまだ返っていない質問の tool_use があればその質問文と種類を返す (質問文が無ければ '')。
 * @param {any[]} entries turnEntries の結果
 * @returns {{question: string, kind: AskKind}|null}
 */
export function pendingAsk(entries) {
  /** @type {Set<string>} */
  const answered = new Set();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const content = e.message?.content;
    if (e.type === 'system') {
      if (e.subtype === 'stop_hook_summary') return null;
      continue;
    }
    if (e.type === 'user') {
      if (e.isMeta === true) continue;
      if (hasToolResult(content)) {
        for (const b of content) if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') answered.add(b.tool_use_id);
        continue;
      }
      const text = firstText(content).trimStart();
      if (PASSIVE_USER_PREFIXES.some((p) => text.startsWith(p))) continue;
      return null; // 指示か中断: ここがターンの始まり
    }
    if (ENDED_STOP_REASONS.has(e.message?.stop_reason)) return null;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b && b.type === 'tool_use' && ASK_TOOLS.includes(b.name) && !answered.has(b.id)) return askOf(b.name, b.input);
    }
  }
  return null;
}

/**
 * 今のターンを始めた指示の行の timestamp (ms)。parseTurn と同じ読み飛ばし規則で後ろからたどり、
 * 最初に当たった「指示」の user 行の timestamp を返す。区切り (stop_hook_summary・end_turn・中断) に
 * 先に当たった、tail の中に無い、timestamp が無い・読めない → undefined (推測しない)。
 * @param {any[]} entries turnEntries の結果
 * @returns {number|undefined}
 */
export function turnStartedAt(entries) {
  const st = { skipCmd: false };
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'system') {
      if (e.subtype === 'stop_hook_summary') return undefined;
      continue;
    }
    if (e.type === 'assistant') {
      if (ENDED_STOP_REASONS.has(e.message?.stop_reason)) return undefined;
      continue;
    }
    const r = judgeUser(e, st);
    if (!r || r.lastKind === 'tool') continue;
    if (r.turn !== 'inprogress') return undefined; // 中断
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    return Number.isFinite(at) ? at : undefined;
  }
  return undefined;
}

/**
 * @param {string} tailText
 * @param {boolean} truncatedHead
 * @returns {TurnResult}
 */
export function parseTurn(tailText, truncatedHead) {
  const entries = turnEntries(tailText, truncatedHead);
  const relevant = entries.length;
  const st = { skipCmd: false };
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'system') {
      if (e.subtype === 'stop_hook_summary') return { turn: 'ended', relevant };
      continue;
    }
    /** @type {Omit<TurnResult, 'relevant'>|null} */
    let r;
    if (e.type === 'user') {
      r = judgeUser(e, st);
      if (!r) continue;
    } else {
      r = ENDED_STOP_REASONS.has(e.message?.stop_reason) ? { turn: 'ended' } : { turn: 'inprogress', lastKind: 'tool' };
    }
    if (r.turn === 'inprogress' && r.lastKind === 'tool') {
      const ask = pendingAsk(entries);
      if (ask) return { turn: 'asking', lastKind: 'tool', question: ask.question, askKind: ask.kind, relevant };
    }
    if (r.turn === 'inprogress') {
      const startedAt = turnStartedAt(entries);
      if (startedAt !== undefined) return { ...r, startedAt, relevant };
    }
    return { ...r, relevant };
  }
  return { turn: 'unknown', relevant };
}
