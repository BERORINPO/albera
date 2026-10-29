import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WAIT_MS } from '../src/runtime/desktop-control.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { createMockDesktopBroker } from '../src/runtime/mock-desktop-broker.mjs';
import { mapComputerToolUse } from '../src/runtime/computer-use-mapping.mjs';
import { createDesktopAgentLoop, costOf, MODEL_PRICES } from '../src/runtime/desktop-agent-loop.mjs';
import { createAnthropicComputerUseClient } from '../src/runtime/anthropic-computer-use-client.mjs';
import { createFakeComputerUseClient, fakeReply, fakeText, fakeToolUse } from '../src/runtime/fake-computer-use-client.mjs';
import { parseRuntimeArgs } from '../src/runtime/entry.mjs';

const screen = Object.freeze({ width: 64, height: 48 });
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const lease = Object.freeze({ desktopSessionId: 'desktop-1', ownerType: 'AI', ownerId: 'agent-1', generation: 1, expiresAt: '2026-10-29T13:00:00.000Z' });
const prices = MODEL_PRICES['claude-haiku-5-5'];
const bigLimits = { maxSteps: 50, maxUsd: 10, maxMs: 3_600_000 };

function setup({ script, limits = bigLimits, current = { ...lease }, now, events = [] } = {}) {
  const broker = createMockDesktopBroker(screen);
  const driver = new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => current, now: () => NOW, screen });
  const client = createFakeComputerUseClient(script);
  const loop = createDesktopAgentLoop({
    driver, client, vmId: 'vm-1', lease, task: 'open notepad', limits, prices,
    now: now ?? (() => NOW), onEvent: (e) => events.push(e),
  });
  return { broker, driver, client, loop, events };
}

// ---- mapping ----

test('mapping: every supported operation maps to a validated ALBERA action', () => {
  const m = (name, input) => mapComputerToolUse(fakeToolUse(name, input), screen);
  assert.deepEqual(m('screenshot', {}), { action: { action: 'screenshot' } });
  assert.deepEqual(m('left_click', { coordinate: [3, 4] }).action, { action: 'left_click', coordinate: [3, 4] });
  assert.deepEqual(m('left_click', {}).action, { action: 'left_click' });
  assert.deepEqual(m('right_click', { coordinate: [3, 4] }).action.action, 'right_click');
  assert.deepEqual(m('double_click', { coordinate: [3, 4] }).action.action, 'double_click');
  assert.deepEqual(m('mouse_move', { coordinate: [1, 2] }).action, { action: 'mouse_move', coordinate: [1, 2] });
  assert.deepEqual(m('left_mouse_down', {}).action, { action: 'left_mouse_down' });
  assert.deepEqual(m('left_mouse_up', {}).action, { action: 'left_mouse_up' });
  assert.deepEqual(m('type', { text: 'hello' }).action, { action: 'type', text: 'hello' });
  assert.deepEqual(m('key', { text: 'ctrl+a', repeat: 2 }).action, { action: 'key', key: 'ctrl+a', repeat: 2 });
  assert.deepEqual(m('scroll', { scroll_direction: 'down', scroll_amount: 5, coordinate: [9, 9] }).action,
    { action: 'scroll', direction: 'down', amount: 5, coordinate: [9, 9] });
  assert.deepEqual(m('wait', { duration: 2 }).action, { action: 'wait', durationMs: 2000 });
  assert.equal(m('wait', { duration: 999 }).action.durationMs, MAX_WAIT_MS);
  assert.deepEqual(m('cursor_position', {}), { cursorQuery: true });
});

test('mapping: unsupported operations and bad arguments are reported, never mapped', () => {
  const m = (name, input) => mapComputerToolUse(fakeToolUse(name, input), screen);
  for (const name of ['triple_click', 'middle_click', 'left_click_drag', 'hold_key', 'zoom', 'bash']) {
    assert.ok(m(name, { coordinate: [1, 1] }).unsupported, name);
  }
  assert.ok(m('left_click', { coordinate: [1, 1], text: 'shift' }).unsupported);
  assert.ok(m('scroll', { scroll_direction: 'left' }).unsupported);
  assert.ok(m('scroll', { scroll_direction: 'up', text: 'ctrl' }).unsupported);
  assert.ok(m('wait', { duration: -1 }).unsupported);
  assert.ok(m('key', { text: 'not-a-key' }).unsupported);
  assert.ok(m('type', { text: 'café' }).unsupported);
});

test('mapping: out-of-range or malformed coordinates are rejected', () => {
  const m = (coordinate) => mapComputerToolUse(fakeToolUse('left_click', { coordinate }), screen);
  assert.ok(m([64, 0]).unsupported);
  assert.ok(m([0, 48]).unsupported);
  assert.ok(m([-1, 0]).unsupported);
  assert.ok(m([1]).unsupported);
  assert.ok(m('1,2').unsupported);
  assert.ok(m([NaN, 1]).unsupported);
  assert.equal(m([1.4, 2.6]).action.coordinate.join(), '1,3');
});

// ---- loop ----

test('loop: a normal run ends as claimed_done and reports usage cost', async () => {
  const { loop, broker, client } = setup({
    script: [
      fakeReply([fakeToolUse('left_click', { coordinate: [5, 6] }, 'a'), fakeToolUse('type', { text: 'hi' }, 'b')], { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }),
      fakeText('DONE: typed hi', 'end_turn', { input_tokens: 0, output_tokens: 0 }),
    ],
  });
  const result = await loop.run();
  assert.equal(result.outcome, 'claimed_done');
  assert.equal(result.claim, 'DONE: typed hi');
  assert.equal(result.steps, 2);
  assert.equal(result.actions, 2);
  assert.equal(result.usd, 0.6);
  assert.deepEqual(broker.inputs.map((i) => i.action.action), ['left_click', 'type']);
  assert.equal(client.calls.length, 2);
});

test('loop: FAILED and an unlabeled final message are claimed_failed; the claim is capped and sanitized', async () => {
  const failed = await setup({ script: [fakeText('FAILED: no such app')] }).loop.run();
  assert.equal(failed.outcome, 'claimed_failed');
  const text = `maybe\u001b[31m ${'x'.repeat(500)}`;
  const other = await setup({ script: [fakeText(text)] }).loop.run();
  assert.equal(other.outcome, 'claimed_failed');
  assert.ok(other.claim.length <= 200);
  assert.ok(!/[\u0000-\u001f]/.test(other.claim));
});

test('loop: pause_turn is resent without adding a user message', async () => {
  const { loop, client } = setup({
    script: [fakeReply([{ type: 'text', text: 'thinking' }], { stopReason: 'pause_turn' }), fakeText('DONE')],
  });
  const result = await loop.run();
  assert.equal(result.outcome, 'claimed_done');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].messages.length, 1);
  assert.equal(client.calls[1].messages.length, 2);
  assert.equal(client.calls[1].messages[1].role, 'assistant');
});

test('loop: refusal ends the run as refused', async () => {
  const { loop } = setup({ script: [fakeText('I cannot help with that', 'refusal')] });
  const result = await loop.run();
  assert.equal(result.outcome, 'refused');
  assert.equal(result.claim, 'I cannot help with that');
});

test('loop: step, cost and time limits stop the run', async () => {
  const click = () => fakeReply([fakeToolUse('mouse_move', { coordinate: [1, 1] })], { usage: { input_tokens: 1_000_000, output_tokens: 0 } });
  const bySteps = setup({ script: [click(), click(), click()], limits: { ...bigLimits, maxSteps: 2 } });
  const stepsResult = await bySteps.loop.run();
  assert.deepEqual([stepsResult.outcome, stepsResult.reason, stepsResult.steps], ['limit_reached', 'max_steps', 2]);

  // one call costs $0.10 at the Haiku price; the limit of $0.15 stops after the second response.
  const byUsd = setup({ script: [click(), click(), click()], limits: { ...bigLimits, maxUsd: 0.15 } });
  const usdResult = await byUsd.loop.run();
  assert.deepEqual([usdResult.outcome, usdResult.reason, usdResult.steps], ['limit_reached', 'max_usd', 2]);
  assert.equal(byUsd.broker.inputs.length, 1, 'actions of the over-limit response are not executed');

  let clock = NOW;
  const byTime = setup({ script: [click(), click()], limits: { ...bigLimits, maxMs: 1000 }, now: () => clock });
  const origSend = byTime.client.send.bind(byTime.client);
  byTime.client.send = async (...args) => { clock += 600; return origSend(...args); };
  const timeResult = await byTime.loop.run();
  assert.deepEqual([timeResult.outcome, timeResult.reason], ['limit_reached', 'max_ms']);
});

test('loop: stop() before an action means the driver is not called again', async () => {
  const broker = createMockDesktopBroker(screen);
  const driver = new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => ({ ...lease }), now: () => NOW, screen });
  let loop;
  const client = createFakeComputerUseClient([
    () => { loop.stop('test_stop'); return fakeReply([fakeToolUse('left_click', { coordinate: [1, 1] })]); },
  ]);
  loop = createDesktopAgentLoop({ driver, client, vmId: 'vm-1', lease, task: 't', limits: bigLimits, prices });
  const result = await loop.run();
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.reason, 'test_stop');
  assert.equal(broker.inputs.length, 0);
  assert.equal(broker.captures.length, 1, 'only the initial capture happened');
});

test('loop: stop() between two actions of one turn skips the rest', async () => {
  const events = [];
  let loop;
  const broker = createMockDesktopBroker(screen);
  const driver = new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => ({ ...lease }), now: () => NOW, screen });
  const client = createFakeComputerUseClient([fakeReply([fakeToolUse('mouse_move', { coordinate: [1, 1] }, 'a'), fakeToolUse('mouse_move', { coordinate: [2, 2] }, 'b')])]);
  loop = createDesktopAgentLoop({ driver, client, vmId: 'vm-1', lease, task: 't', limits: bigLimits, prices, onEvent: (e) => { events.push(e); if (e.type === 'action') loop.stop('mid'); } });
  const result = await loop.run();
  assert.equal(result.outcome, 'stopped');
  assert.equal(broker.inputs.length, 1);
});

test('loop: a lease rejection ends the run at once without telling the AI to retry', async () => {
  const stale = { ...lease, generation: 2 };
  const { loop, client, broker } = setup({ script: [fakeText('DONE')], current: stale });
  const result = await loop.run();
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'desktop_lease_stale');
  assert.equal(client.calls.length, 0);
  assert.equal(broker.inputs.length, 0);

  // lease goes bad after the first capture
  let current = { ...lease };
  const broker2 = createMockDesktopBroker(screen);
  const driver = new HyperVDesktopDriver({ broker: broker2, resolveCurrentLease: async () => current, now: () => NOW, screen });
  const client2 = createFakeComputerUseClient([
    () => { current = { ...lease, generation: 9 }; return fakeReply([fakeToolUse('left_click', { coordinate: [1, 1] })]); },
    fakeText('DONE'),
  ]);
  const result2 = await createDesktopAgentLoop({ driver, client: client2, vmId: 'vm-1', lease, task: 't', limits: bigLimits, prices }).run();
  assert.equal(result2.outcome, 'error');
  assert.equal(result2.reason, 'desktop_lease_stale');
  assert.equal(client2.calls.length, 1, 'the AI is not asked again');
});

test('loop: tool_result shape, screenshot image, unsupported action and Not executed', async () => {
  const { loop, client } = setup({
    script: [
      fakeReply([
        fakeToolUse('screenshot', {}, 't1'),
        fakeToolUse('triple_click', { coordinate: [1, 1] }, 't2'),
        fakeToolUse('left_click', { coordinate: [1, 1] }, 't3'),
      ]),
      fakeReply([fakeToolUse('cursor_position', {}, 't4')]),
      fakeText('DONE'),
    ],
  });
  await loop.run();
  const [r1, r2, r3] = client.calls[1].messages[2].content;
  assert.deepEqual([r1.type, r1.tool_use_id, r1.toolset_name], ['tool_result', 't1', 'computer']);
  assert.equal(r1.content[0].type, 'image');
  assert.equal(r1.content[0].source.media_type, 'image/png');
  assert.equal(r2.is_error, true);
  assert.equal(r2.toolset_name, 'computer');
  assert.equal(r3.is_error, true);
  assert.equal(r3.content, 'Not executed: an earlier computer action in this turn failed.');
  assert.equal(r3.toolset_name, 'computer');
});

test('loop: cursor_position answers the last commanded coordinate; actions that succeed return OK', async () => {
  const { loop, client } = setup({
    script: [fakeReply([fakeToolUse('mouse_move', { coordinate: [7, 8] }, 'm'), fakeToolUse('cursor_position', {}, 'c')]), fakeText('DONE')],
  });
  await loop.run();
  const [m, c] = client.calls[1].messages[2].content;
  assert.equal(m.content, 'OK');
  assert.equal(m.is_error, undefined);
  assert.equal(c.content, 'X=7,Y=8');
});

test('loop: an unexpected driver failure is returned to the AI as an error, and the run continues', async () => {
  const ctx = setup({ script: [] });
  const client = createFakeComputerUseClient([
    () => { ctx.broker.failNext('desktop_input_rejected', 'not_applied'); return fakeReply([fakeToolUse('left_click', { coordinate: [1, 1] }, 'x')]); },
    fakeText('FAILED: input broke'),
  ]);
  const loop = createDesktopAgentLoop({ driver: ctx.driver, client, vmId: 'vm-1', lease, task: 't', limits: bigLimits, prices });
  const result = await loop.run();
  assert.equal(result.outcome, 'claimed_failed');
  const [r] = client.calls[1].messages[2].content;
  assert.equal(r.is_error, true);
  assert.match(r.content, /desktop_input_rejected/);
});

test('loop: the message list is append-only across calls', async () => {
  const { loop, client } = setup({
    script: [
      fakeReply([fakeToolUse('screenshot', {}, 'a')]),
      fakeReply([{ type: 'text', text: 'p' }], { stopReason: 'pause_turn' }),
      fakeReply([fakeToolUse('left_click', { coordinate: [1, 1] }, 'b')]),
      fakeText('DONE'),
    ],
  });
  await loop.run();
  assert.equal(client.calls.length, 4);
  for (let i = 1; i < client.calls.length; i++) {
    const prev = client.calls[i - 1].messages;
    assert.deepEqual(client.calls[i].messages.slice(0, prev.length), prev, `call ${i} extends call ${i - 1}`);
    assert.ok(client.calls[i].messages.length > prev.length);
  }
  assert.match(client.calls[0].system, /DONE/);
});

test('loop: events carry no screen data, key names or typed text, but do carry the cursor and text length', async () => {
  const secret = 'hunter2-secret';
  const { loop, events } = setup({
    script: [
      fakeReply([fakeToolUse('screenshot', {}), fakeToolUse('mouse_move', { coordinate: [4, 5] }), fakeToolUse('type', { text: secret }), fakeToolUse('key', { text: 'ctrl+shift+s' })]),
      fakeText('DONE'),
    ],
  });
  await loop.run();
  const json = JSON.stringify(events);
  assert.ok(!json.includes(secret));
  assert.ok(!json.includes('ctrl+shift+s'));
  assert.ok(!/iVBOR|base64|png/i.test(json));
  assert.equal(events.find((e) => e.type === 'action' && e.action === 'type').textLength, secret.length);
  assert.deepEqual(events.find((e) => e.type === 'action' && e.action === 'type').cursor, [4, 5]);
  assert.deepEqual(events.map((e) => e.type).filter((t, i, a) => a.indexOf(t) === i).sort(), ['action', 'end', 'step']);
  assert.equal(events.at(-1).type, 'end');
});

test('loop: a client failure ends as error with only a safe code', async () => {
  const boom = Object.assign(new Error('sk-ant-leak'), { code: 'anthropic_http_529' });
  const result = await setup({ script: [boom] }).loop.run();
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'anthropic_http_529');
  assert.ok(!JSON.stringify(result).includes('sk-ant'));
});

test('costOf: cache writes cost x1.25 and cache reads x0.1 of the input price', () => {
  const usage = { input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 1_000_000 };
  assert.equal(Math.round(costOf(usage, { input: 2, output: 10 }) * 1e6) / 1e6, 2 + 2.5 + 0.2 + 10);
});

// ---- real client with a fake fetch ----

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}
const okResponse = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1 } }), { status: 200 });
const errResponse = (status, type = 'overloaded_error') => new Response(JSON.stringify({ error: { type, message: 'sk-ant-SECRETKEY is bad' } }), { status });

test('client: request shape, and only content/stopReason/usage come back', async () => {
  const f = fakeFetch([okResponse()]);
  const client = createAnthropicComputerUseClient({ apiKey: 'sk-ant-SECRETKEY', fetchImpl: f.impl, sleep: async () => {} });
  const out = await client.send([{ role: 'user', content: 'x' }], 'sys');
  assert.deepEqual(Object.keys(out).sort(), ['content', 'stopReason', 'usage']);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'sk-ant-SECRETKEY');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['anthropic-beta'], undefined);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.deepEqual(body.tools, [{ type: 'computer_toolset_20260801', configs: { zoom: { enabled: false } } }]);
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.equal(body.max_tokens, 8192);
  for (const key of ['thinking', 'temperature', 'top_p', 'top_k']) assert.equal(key in body, false);
});

test('client: 429 and 5xx are retried up to 3 times, then fail without exposing the key', async () => {
  const f = fakeFetch([errResponse(429, 'rate_limit_error'), errResponse(529), okResponse()]);
  const client = createAnthropicComputerUseClient({ apiKey: 'sk-ant-SECRETKEY', fetchImpl: f.impl, sleep: async () => {} });
  assert.equal((await client.send([], 's')).stopReason, 'end_turn');
  assert.equal(f.calls.length, 3);

  const g = fakeFetch([errResponse(500), errResponse(500), errResponse(500), errResponse(500), okResponse()]);
  const failing = createAnthropicComputerUseClient({ apiKey: 'sk-ant-SECRETKEY', fetchImpl: g.impl, sleep: async () => {} });
  await assert.rejects(failing.send([], 's'), (error) => {
    assert.equal(error.code, 'anthropic_http_500_overloaded_error');
    assert.ok(!String(error.message).includes('SECRETKEY') && !String(error.stack).includes('SECRETKEY'));
    return true;
  });
  assert.equal(g.calls.length, 4, '1 try + 3 retries');
});

test('client: a 400 is not retried; a network error is retried and never leaks the key', async () => {
  const f = fakeFetch([errResponse(400, 'invalid_request_error')]);
  const client = createAnthropicComputerUseClient({ apiKey: 'sk-ant-SECRETKEY', fetchImpl: f.impl, sleep: async () => {} });
  await assert.rejects(client.send([], 's'), { code: 'anthropic_http_400_invalid_request_error' });
  assert.equal(f.calls.length, 1);

  const g = fakeFetch([new TypeError('fetch failed sk-ant-SECRETKEY'), okResponse()]);
  const retrying = createAnthropicComputerUseClient({ apiKey: 'sk-ant-SECRETKEY', fetchImpl: g.impl, sleep: async () => {} });
  assert.equal((await retrying.send([], 's')).stopReason, 'end_turn');
  assert.equal(g.calls.length, 2);
});

test('client: a timeout and an abort fail with their own codes; a missing key is refused', async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const slow = createAnthropicComputerUseClient({ apiKey: 'k', fetchImpl: hang, timeoutMs: 20, sleep: async () => {} });
  await assert.rejects(slow.send([], 's'), { code: 'anthropic_timeout' });

  const controller = new AbortController();
  const waiting = createAnthropicComputerUseClient({ apiKey: 'k', fetchImpl: hang, sleep: async () => {} });
  const pending = waiting.send([], 's', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'computer_use_aborted' });

  assert.throws(() => createAnthropicComputerUseClient({ apiKey: '' }), { message: 'anthropic_api_key_required' });
});

// ---- CLI parsing ----

test('entry: agent arguments have safe defaults and strict validation', () => {
  const ok = parseRuntimeArgs(['agent', '--vm', 'vm-1', '--task', 'do it']);
  assert.deepEqual([ok.command, ok.vm, ok.task, ok.model, ok.maxSteps, ok.maxUsd, ok.maxMinutes], ['agent', 'vm-1', 'do it', 'claude-haiku-5-5', 40, 0.5, 15]);
  assert.throws(() => parseRuntimeArgs(['agent', '--vm', 'vm-1']), /runtime_agent_vm_and_task_required/);
  assert.throws(() => parseRuntimeArgs(['agent', '--vm', 'v', '--task', 't', '--max-usd', '0']), /runtime_agent_limit_invalid/);
  assert.throws(() => parseRuntimeArgs(['agent', '--vm', 'v', '--task', 't', '--max-steps', '2.5']), /runtime_agent_limit_invalid/);
  assert.throws(() => parseRuntimeArgs(['agent', '--vm', 'v', '--task', 't', '--model', 'gpt-x']), /runtime_agent_model_unknown/);
  assert.throws(() => parseRuntimeArgs(['agent', '--vm', 'v', '--task', 't', '--api-key', 'k']), /invalid_runtime_option/);
  assert.equal(parseRuntimeArgs(['agent', '--help']).help, true);
});
