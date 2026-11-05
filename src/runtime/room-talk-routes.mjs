import { ID_PATTERN } from './broker-contract/action-digest.mjs';
import { MAIN_AI_FAILURES, parseReply, wordsProblem } from './main-ai-contract.mjs';
import { cleanText } from './room-contract.mjs';

// The room's talk panel (docs/architecture/mission-approval.md, roadmap Phase 1; spec/room.md section 10). Routes for room-host.mjs `apiRoutes`: the host checks Origin, Sec-Fetch-Site, the content
// type, the session cookie and the body limit before any handler here runs, and the handler never sees the request. Nothing here touches a pipe, a process, a clock or a disk.
//
//   GET  /api/talk         -> { ok, available, busy, messages: [Message] }     `available` is false for a room where the main AI is not switched on (disabledMainAi): the page says so
//   POST /api/talk         { words } -> { ok, available, busy: false, messages }     one turn: the main AI answers; its reply may carry a proposal
//   POST /api/talk/reset   {} -> { ok, available, busy: false, messages: [] }        forget the conversation
//   Message = { id, who: 'you' | 'bero', text, proposal?: { goal, computerId, label } }
//
// The main AI is the injected adapter (main-ai-claude.mjs; fake-main-ai.mjs in tests): `mainAi.turn({ words, state }) -> { ok: true, text } | { ok: false, code }`. What it returns is untrusted text:
//  - parseReply (main-ai-contract.mjs) checks it. A reply that does not pass, or that proposes a computer this room does not offer, is the fixed `reply_invalid`. There is no second try.
//  - A proposal is only shown. It starts nothing here: the page sends its goal to the existing job route (room-job-routes.mjs), where the person approves that one job. Nothing in this file can reach
//    an approval, the Broker or the hands. `maxStarts` and `minutes` are checked by the contract and then dropped: Phase 1 has nothing that enforces them, so no screen may state them.
//  - `next` and `done` are valid replies that Phase 1 ignores (only `say` and `propose` are acted on).
//  - One turn at a time (`busy`). A turn that fails changes nothing: the person's words are kept only with the answer they got, so the page can offer them again.
// The conversation lives in this closure only: at most MAX_MESSAGES kept, the last HISTORY_MESSAGES shown to the model. Failures are fixed codes (an adapter's own, or `reply_invalid`); no words, no
// model text and no error text are ever logged or returned.

export const TALK_MAX_BODY_BYTES = 4096;
export const MAX_MESSAGES = 40;
export const HISTORY_MESSAGES = 10;
export const MAX_LABEL = 64;
const ID_RE = new RegExp(ID_PATTERN, 'u');
const FAILURES = new Set(MAIN_AI_FAILURES);
const REPLY_REASONS = new Set(['size', 'not_json', 'shape', 'say', 'many_actions', 'propose', 'next', 'done']);
const fail = (status, error) => ({ status, body: { error } });
const hasExactly = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** The computers a job may name, as the job screen lists them. */
function computersOf(targets) {
  let list;
  try { list = targets(); } catch { list = []; }
  return (Array.isArray(list) ? list : []).filter((t) => typeof t?.computerId === 'string' && ID_RE.test(t.computerId))
    .map((t) => ({ computerId: t.computerId, label: cleanText(typeof t.label === 'string' ? t.label : t.computerId, MAX_LABEL) || t.computerId }));
}

/**
 * @param {{ mainAi: { turn: Function }, targets: () => {computerId: string, label?: string}[], log?: (line: string) => void }} deps
 * @returns {readonly object[]} routes for createRoomHost({ apiRoutes })
 */
export function createRoomTalkRoutes({ mainAi, targets, log = () => {} } = {}) {
  if (typeof mainAi?.turn !== 'function' || typeof targets !== 'function' || typeof log !== 'function') throw new TypeError('invalid_room_talk_dependencies');
  const messages = []; // oldest first; records owned by this closure, clients only ever see views
  let counter = 0;
  let busy = false;

  const note = (line) => { try { log(line); } catch { /* logging must not break a turn */ } };
  const view = (m) => ({ id: m.id, who: m.who, text: m.text, ...(m.proposal ? { proposal: { ...m.proposal } } : {}) });
  const snapshot = () => ({ ok: true, available: mainAi.available !== false, busy, messages: messages.map(view) });

  function remember(who, text, proposal) {
    counter += 1;
    messages.push({ id: `m-${counter}`, who, text, ...(proposal ? { proposal } : {}) });
    while (messages.length > MAX_MESSAGES) messages.shift();
  }

  /** What the model is shown of the conversation so far: who said what, and which job it proposed. Never the maxStarts / minutes it was never allowed to promise. */
  const historyOf = () => messages.slice(-HISTORY_MESSAGES).map((m) => ({ who: m.who, text: m.text, ...(m.proposal ? { proposed: { goal: m.proposal.goal, computerId: m.proposal.computerId } } : {}) }));

  async function ask(words, computers) {
    let answer = null;
    try { answer = await mainAi.turn({ words, state: { computers, history: historyOf() } }); } catch { answer = null; }
    if (answer?.ok === true && typeof answer.text === 'string') return { text: answer.text };
    return { code: FAILURES.has(answer?.code) ? answer.code : 'main_ai_failed' };
  }

  /** The reply as a message to keep: its `say`, and a proposal when it has one for a computer this room offers. null when the reply cannot be used. */
  function accept(text, computers) {
    const parsed = parseReply(text);
    if (!parsed.ok) { note(`talk reply_invalid reason=${REPLY_REASONS.has(parsed.reason) ? parsed.reason : 'other'}`); return null; }
    const { say, propose } = parsed.reply;
    if (propose === undefined) return { say };
    const computer = computers.find((c) => c.computerId === propose.computerId);
    if (!computer) { note('talk reply_invalid reason=computer'); return null; }
    return { say, proposal: { goal: propose.goal, computerId: computer.computerId, label: computer.label } };
  }

  async function turn(words) {
    const computers = computersOf(targets);
    const answer = await ask(words, computers);
    if (answer.code) return fail(502, answer.code);
    const reply = accept(answer.text, computers);
    if (reply === null) return fail(502, 'reply_invalid');
    remember('you', words);
    remember('bero', reply.say, reply.proposal);
    return { status: 200, body: { ...snapshot(), busy: false } };
  }

  function list() {
    return { status: 200, body: snapshot() };
  }

  async function talk({ body }) {
    if (!hasExactly(body, ['words'])) return fail(400, 'invalid_request');
    const problem = wordsProblem(body.words);
    if (problem) return fail(400, problem);
    if (busy) return fail(409, 'busy');
    busy = true;
    try { return await turn(body.words); } finally { busy = false; }
  }

  function reset({ body }) {
    if (!hasExactly(body, [])) return fail(400, 'invalid_request');
    if (busy) return fail(409, 'busy');
    messages.length = 0;
    return { status: 200, body: snapshot() };
  }

  return Object.freeze([
    Object.freeze({ method: 'GET', path: '/api/talk', handle: list }),
    Object.freeze({ method: 'POST', path: '/api/talk', maxBody: TALK_MAX_BODY_BYTES, handle: talk }),
    Object.freeze({ method: 'POST', path: '/api/talk/reset', maxBody: 64, handle: reset }),
  ]);
}
