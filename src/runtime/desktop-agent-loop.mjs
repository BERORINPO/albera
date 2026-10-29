import { mapComputerToolUse } from './computer-use-mapping.mjs';

/**
 * Desktop agent loop: capture the screen -> ask the AI (computer use) -> map its tool calls to
 * ALBERA desktop actions -> act, repeated under hard limits (steps, USD, time) and a human stop.
 *
 * IMPORTANT: `claimed_done` / `claimed_failed` record only what the AI SAID in its last message.
 * They are claims, never a verdict. Whether the task really succeeded must be checked separately.
 *
 * Screen contents are untrusted input (ADR-009). The loop never creates a lease: the caller owns it,
 * and a lease rejection from the driver ends the run at once (the AI is not told to retry).
 * Events (`onEvent`) never carry screen data, key names or typed text (only its length).
 */

export const AGENT_SYSTEM_PROMPT = 'You operate a Windows desktop through the computer tools. '
  + 'Use only the graphical interface: do not open Command Prompt, PowerShell, Windows Terminal, '
  + 'or the Run dialog. After an action that changes the screen, take a screenshot before deciding '
  + 'the next step. When the task is complete, stop calling tools and reply with one line starting '
  + 'with DONE. If you cannot finish, reply with one line starting with FAILED and the reason.';

/** USD per million tokens. Unknown models are rejected by the caller: a cost limit needs a price. */
export const MODEL_PRICES = Object.freeze({
  'claude-haiku-5-5': Object.freeze({ input: 0.10, output: 0.50 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2, output: 10 }),
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20 }),
});

export const OUTCOMES = Object.freeze(['claimed_done', 'claimed_failed', 'limit_reached', 'stopped', 'refused', 'error']);
const CACHE_WRITE_RATIO = 1.25;
const CACHE_READ_RATIO = 0.1;
const MAX_CLAIM_LENGTH = 200;
const NOT_EXECUTED = 'Not executed: an earlier computer action in this turn failed.';

export function createDesktopAgentLoop({
  driver, client, vmId, lease, task, limits, prices, now = Date.now, onEvent = () => {},
  settleMs = 0, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  if (!driver || typeof driver.capture !== 'function' || typeof driver.act !== 'function') throw new TypeError('invalid_agent_driver');
  if (!client || typeof client.send !== 'function') throw new TypeError('invalid_agent_client');
  if (typeof task !== 'string' || task.length < 1) throw new TypeError('invalid_agent_task');
  if (!limits || !isPositive(limits.maxSteps) || !isPositive(limits.maxUsd) || !isPositive(limits.maxMs)) throw new TypeError('invalid_agent_limits');
  if (!prices || !isPositive(prices.input) || !isPositive(prices.output)) throw new TypeError('invalid_agent_prices');

  const abort = new AbortController();
  let stopReason = null;
  const emit = (event) => { try { onEvent(Object.freeze(event)); } catch { /* a listener must not break the loop */ } };

  function stop(reason = 'stopped') {
    if (stopReason !== null) return;
    stopReason = String(reason).slice(0, 80);
    abort.abort();
  }

  async function run() {
    const started = now();
    const state = { steps: 0, actions: 0, usd: 0, cursor: null, screen: null };
    const elapsed = () => now() - started;
    const finish = (outcome, { claim = '', reason } = {}) => {
      const result = Object.freeze({
        outcome, claim, reason, steps: state.steps, actions: state.actions,
        usd: Math.round(state.usd * 1e6) / 1e6, ms: elapsed(),
      });
      emit({ type: 'end', ...result });
      return result;
    };

    let messages;
    try {
      const first = await driver.capture({ vmId, lease });
      state.screen = { width: first.width, height: first.height };
      messages = [{ role: 'user', content: [imageBlock(first.png), { type: 'text', text: task }] }];
    }
    catch (error) { return finish('error', { reason: safeCode(error) }); }

    for (;;) {
      if (stopReason !== null) return finish('stopped', { reason: stopReason });
      const limit = state.steps >= limits.maxSteps ? 'max_steps' : overLimit(state, limits, elapsed());
      if (limit) return finish('limit_reached', { reason: limit });
      state.steps++;
      let response;
      try { response = await client.send(messages, AGENT_SYSTEM_PROMPT, { signal: abort.signal }); }
      catch (error) {
        if (stopReason !== null) return finish('stopped', { reason: stopReason });
        return finish('error', { reason: safeCode(error) });
      }
      state.usd += costOf(response.usage, prices);
      messages.push({ role: 'assistant', content: response.content });
      const toolUses = response.content.filter((b) => b?.type === 'tool_use');
      const claim = claimOf(response.content);
      emit({ type: 'step', step: state.steps, usd: roundUsd(state.usd), ms: elapsed(), toolUses: toolUses.length, stopReason: response.stopReason });
      if (response.stopReason === 'refusal') return finish('refused', { claim });
      if (stopReason !== null) return finish('stopped', { reason: stopReason });
      if (toolUses.length === 0) {
        if (response.stopReason === 'pause_turn') continue; // resend as is; no user message is added
        if (response.stopReason !== 'end_turn') return finish('error', { claim, reason: `stop_reason_${safeToken(response.stopReason)}` });
        return finish(/^\s*DONE/i.test(claim) ? 'claimed_done' : 'claimed_failed', { claim });
      }
      const spent = overLimit(state, limits, elapsed());
      if (spent) return finish('limit_reached', { claim, reason: spent });
      const executed = await runToolUses(toolUses, state, elapsed);
      if (executed.halt) return finish(executed.halt.outcome, { reason: executed.halt.reason });
      messages.push({ role: 'user', content: executed.results });
    }
  }

  async function runToolUses(toolUses, state, elapsed) {
    const results = [];
    let failed = false;
    for (const block of toolUses) {
      if (stopReason !== null) return { halt: { outcome: 'stopped', reason: stopReason } };
      if (elapsed() >= limits.maxMs) return { halt: { outcome: 'limit_reached', reason: 'max_ms' } };
      const result = { type: 'tool_result', tool_use_id: block.id };
      if (block.toolset_name !== 'computer') {
        failed = true;
        results.push({ ...result, is_error: true, content: 'Unknown tool.' });
        continue;
      }
      result.toolset_name = block.toolset_name;
      if (failed) {
        results.push({ ...result, is_error: true, content: NOT_EXECUTED });
        continue;
      }
      const outcome = await runOne(block, state);
      if (outcome.halt) return { halt: outcome.halt };
      failed = outcome.isError;
      results.push({ ...result, ...(outcome.isError ? { is_error: true } : {}), content: outcome.content });
    }
    return { results };
  }

  async function runOne(block, state) {
    const mapped = mapComputerToolUse(block, state.screen);
    const base = { type: 'action', step: state.steps, action: String(block.name).slice(0, 32) };
    if (mapped.unsupported) {
      emit({ ...base, ok: false, code: mapped.unsupported, cursor: state.cursor });
      return { isError: true, content: `Unsupported action: ${mapped.unsupported}` };
    }
    if (mapped.cursorQuery) {
      emit({ ...base, ok: true, cursor: state.cursor });
      return { isError: false, content: state.cursor ? `X=${state.cursor[0]},Y=${state.cursor[1]}` : 'Unknown: no pointer position has been commanded yet.' };
    }
    const { action } = mapped;
    try {
      state.actions++;
      let content = 'OK';
      if (action.action === 'screenshot') {
        const shot = await driver.capture({ vmId, lease });
        content = [imageBlock(shot.png)];
      }
      else {
        await driver.act({ vmId, lease, action });
        if (action.coordinate) state.cursor = action.coordinate;
        if (settleMs > 0) await sleep(settleMs);
      }
      emit({ ...base, ok: true, cursor: state.cursor, ...(action.action === 'type' ? { textLength: action.text.length } : {}) });
      return { isError: false, content };
    }
    catch (error) {
      const code = safeCode(error);
      emit({ ...base, ok: false, code, cursor: state.cursor });
      if (code.startsWith('desktop_lease_') || code === 'invalid_desktop_lease') return { halt: { outcome: 'error', reason: code } };
      return { isError: true, content: `Action failed: ${code}` };
    }
  }

  return Object.freeze({ run, stop });
}

function overLimit(state, limits, ms) {
  if (state.usd >= limits.maxUsd) return 'max_usd';
  if (ms >= limits.maxMs) return 'max_ms';
  return null;
}

export function costOf(usage, prices) {
  const u = usage ?? {};
  const n = (key) => (Number.isFinite(u[key]) && u[key] > 0 ? u[key] : 0);
  return (n('input_tokens') * prices.input
    + n('cache_creation_input_tokens') * prices.input * CACHE_WRITE_RATIO
    + n('cache_read_input_tokens') * prices.input * CACHE_READ_RATIO
    + n('output_tokens') * prices.output) / 1_000_000;
}

function claimOf(content) {
  const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
  // Control characters are removed so an AI-written line cannot drive a terminal.
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_CLAIM_LENGTH);
}

function imageBlock(png) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } };
}

function safeCode(error) { return safeToken(error?.code) || 'agent_error'; }
function safeToken(value) { return typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : ''; }
function roundUsd(usd) { return Math.round(usd * 1e6) / 1e6; }
function isPositive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
