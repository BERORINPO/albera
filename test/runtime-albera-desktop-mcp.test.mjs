import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { buildDesktopMcpArgs, desktopMcpLimitArgs, parseDesktopMcpArgs } from '../src/runtime/albera-desktop-mcp-args.mjs';
import { createDesktopMcpServer, DESKTOP_TOOL_NAMES, MAX_CONSECUTIVE_FAILURES, serveDesktopMcp } from '../src/runtime/albera-desktop-mcp-server.mjs';
import { MCP_ENTRY_ERRORS, runDesktopMcpEntry } from '../src/runtime/albera-desktop-mcp.mjs';
import { createFakeDesktopBrokerClient } from '../src/runtime/fake-desktop-broker-client.mjs';
import { planDesktopInput } from '../src/runtime/desktop-control.mjs';

const SCREEN = Object.freeze({ width: 640, height: 480 });
const NOW = 1_000_000;
const HASH = 'a'.repeat(64);

function setup({ maxCalls = 50, expiresAtMs = NOW + 60_000, leaseGeneration = null, now = { t: NOW } } = {}) {
  const client = createFakeDesktopBrokerClient({ computers: ['computer-1'] });
  const generation = client.grantLease('computer-1', 'op-1');
  const server = createDesktopMcpServer({ client, computerId: 'computer-1', operationId: 'op-1', leaseGeneration: leaseGeneration === null ? null : generation, screen: SCREEN, maxCalls, expiresAtMs, now: () => now.t });
  let id = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: ++id, method, params });
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  return { client, server, rpc, call, now };
}

// ---- command line ----

test('args: build and parse round-trip; the limits are the driver\'s two numbers', () => {
  const broker = { pipeName: 'albera-broker', serviceName: 'AlberaBroker', helperPath: 'C:\\Program Files\\Albera\\helper.exe', helperSha256: HASH };
  const args = buildDesktopMcpArgs({ entryPath: 'C:\\x\\main.mjs', computerId: 'computer-1', operationId: 'start-ab12', leaseGeneration: 3, screen: SCREEN, maxCalls: 40, expiresAtMs: 123456, broker });
  assert.equal(args[0], 'C:\\x\\main.mjs');
  assert.deepEqual(parseDesktopMcpArgs(args.slice(1)), { computerId: 'computer-1', operationId: 'start-ab12', leaseGeneration: 3, screen: SCREEN, maxCalls: 40, expiresAtMs: 123456, broker });
  assert.deepEqual(desktopMcpLimitArgs({ maxCalls: 40, expiresAtMs: 123456 }), ['--max-calls', '40', '--expires-at', '123456']);
});

test('args: strict - unknown or repeated flags, missing values, bad ids, partial broker group are refused without echoing a value', () => {
  const base = ['--computer', 'computer-1', '--operation', 'op-1', '--max-calls', '5', '--expires-at', '9'];
  assert.equal(parseDesktopMcpArgs(base).broker, null);
  const bad = [
    [...base, '--extra', 'x'], [...base, '--computer', 'computer-2'], base.slice(0, -1), ['--computer', 'bad id', ...base.slice(2)],
    [...base, '--max-calls'], ['--computer', 'computer-1', '--operation', 'op-1', '--expires-at', '9'], [...base, '--screen', '0x10'], [...base, '--screen', '99999x1'],
    [...base, '--lease-generation', '0'], [...base, '--pipe-name', 'p'], [...base, '--helper', 'relative.exe', '--pipe-name', 'p', '--service-name', 's', '--helper-sha256', HASH],
    [...base, '--helper', '\\\\server\\share\\h.exe', '--pipe-name', 'p', '--service-name', 's', '--helper-sha256', HASH],
  ];
  for (const argv of bad) assert.throws(() => parseDesktopMcpArgs(argv), (error) => error.message === 'invalid_desktop_mcp_args', JSON.stringify(argv));
  assert.throws(() => desktopMcpLimitArgs({ maxCalls: 0, expiresAtMs: 1 }), TypeError);
});

// ---- protocol ----

test('protocol: initialize, ping, tools/list; notifications get no answer; unknown method and non-requests are errors', async () => {
  const { server, rpc } = setup();
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, 'albera_desktop');
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  assert.deepEqual((await rpc('ping')).result, {});
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await rpc('resources/list')).error.code, -32601);
  assert.equal((await server.handle([])).error.code, -32600);
  assert.equal((await server.handle({ jsonrpc: '1.0', id: 1, method: 'ping' })).error.code, -32600);
  assert.equal((await rpc('tools/call', { name: 'bash', arguments: {} })).error.code, -32602);
});

test('tools/list: exactly screenshot, click, move, key, type, scroll; every schema is closed and has no computer or lease field', async () => {
  const { rpc } = setup();
  const { tools } = (await rpc('tools/list')).result;
  assert.deepEqual(tools.map((tool) => tool.name), ['screenshot', 'click', 'move', 'key', 'type', 'scroll']);
  assert.deepEqual(DESKTOP_TOOL_NAMES, tools.map((tool) => tool.name));
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 10);
    for (const forbidden of ['computerId', 'vmId', 'computer', 'operationId', 'lease', 'leaseGeneration', 'desktopSessionId']) assert.ok(!(forbidden in tool.inputSchema.properties), `${tool.name}.${forbidden}`);
    for (const required of tool.inputSchema.required) assert.ok(required in tool.inputSchema.properties);
  }
  assert.deepEqual(tools.find((t) => t.name === 'click').inputSchema.required, ['coordinate']);
  assert.deepEqual(tools.find((t) => t.name === 'key').inputSchema.required, ['key']);
});

// ---- screenshot ----

test('screenshot: MCP image content in the shape of the spec (type image, base64 PNG, mimeType image/png) for the configured size', async () => {
  const { call, client } = setup();
  const result = await call('screenshot');
  assert.equal(result.isError, false);
  const image = result.content[0];
  assert.deepEqual(Object.keys(image).sort(), ['data', 'mimeType', 'type']);
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), SCREEN.width);
  assert.equal(png.readUInt32BE(20), SCREEN.height);
  assert.deepEqual(client.captures, [{ computerId: 'computer-1', width: 640, height: 480 }]);
  assert.match(result.content[1].text, /640x480/u);
});

test('screenshot: a PNG of the wrong size from the client is refused, not forwarded', async () => {
  const wrong = { captureVmScreen: async () => createFakeDesktopBrokerClient().captureVmScreen({ vmId: 'computer-1', width: 100, height: 100 }), sendVmInput: async () => ({ ok: true }) };
  const server = createDesktopMcpServer({ client: wrong, computerId: 'computer-1', operationId: 'op-1', screen: SCREEN, maxCalls: 5, expiresAtMs: NOW + 1, now: () => NOW });
  const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: {} } });
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content.length, 1);
  assert.match(reply.result.content[0].text, /invalid_desktop_screen_data/u);
});

// ---- input tools ----

test('input tools: each becomes the room\'s ALBERA action (same planner) and reaches sendVmInput on the fixed computer and lease', async () => {
  const { call, client } = setup({ leaseGeneration: 1 });
  const cases = [
    ['click', { coordinate: [10, 20] }, { action: 'left_click', coordinate: [10, 20] }],
    ['click', { coordinate: [10, 20], button: 'right' }, { action: 'right_click', coordinate: [10, 20] }],
    ['click', { coordinate: [10, 20], button: 'middle' }, { action: 'middle_click', coordinate: [10, 20] }],
    ['click', { coordinate: [10, 20], clicks: 2, modifiers: 'Shift' }, { action: 'double_click', coordinate: [10, 20], modifiers: 'shift' }],
    ['click', { coordinate: [10, 20], clicks: 3 }, { action: 'triple_click', coordinate: [10, 20] }],
    ['move', { coordinate: [639, 479] }, { action: 'mouse_move', coordinate: [639, 479] }],
    ['key', { key: 'Ctrl+C' }, { action: 'key', key: 'ctrl+c' }],
    ['key', { key: 'tab', repeat: 3 }, { action: 'key', key: 'tab', repeat: 3 }],
    ['type', { text: 'hello world' }, { action: 'type', text: 'hello world' }],
    ['scroll', { direction: 'down' }, { action: 'scroll', direction: 'down' }],
    ['scroll', { direction: 'up', amount: 5, coordinate: [1, 2], modifiers: 'ctrl' }, { action: 'scroll', direction: 'up', amount: 5, coordinate: [1, 2], modifiers: 'ctrl' }],
  ];
  for (const [name, args, action] of cases) {
    const result = await call(name, args);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'OK' }], isError: false }, `${name} ${JSON.stringify(args)}`);
    const sent = client.inputs.at(-1);
    assert.deepEqual(sent.steps, [...planDesktopInput(action, SCREEN)], `${name} plan`);
    assert.equal(sent.computerId, 'computer-1');
    assert.equal(sent.operationId, 'op-1');
    assert.equal(sent.leaseGeneration, 1);
  }
  assert.equal(client.inputs.length, cases.length);
});

test('input tools: without a configured generation the lease is the operation id alone', async () => {
  const { call, client } = setup();
  await call('key', { key: 'return' });
  assert.equal(client.inputs[0].leaseGeneration, null);
  assert.equal(client.inputs[0].operationId, 'op-1');
});

test('input tools: the model cannot name another computer or lease - the extra field is refused and nothing is sent', async () => {
  const { call, client } = setup();
  for (const extra of [{ computerId: 'computer-2' }, { vmId: 'computer-2' }, { operationId: 'op-2' }, { lease: { desktopSessionId: 'op-2' } }, { leaseGeneration: 9 }]) {
    const result = await call('click', { coordinate: [1, 1], ...extra });
    assert.equal(result.isError, true, JSON.stringify(extra));
  }
  assert.equal(client.inputs.length, 0);
});

test('input tools: arguments outside the room\'s limits are refused before the client (coordinates, ASCII, key names, repeat, clicks, modifiers)', async () => {
  const bad = [
    ['click', { coordinate: [640, 10] }], ['click', { coordinate: [-1, 10] }], ['click', { coordinate: [1.5, 2] }], ['click', {}], ['click', { coordinate: [1, 1], clicks: 2, button: 'right' }],
    ['click', { coordinate: [1, 1], clicks: 4 }], ['click', { coordinate: [1, 1], button: 'x' }], ['click', { coordinate: [1, 1], modifiers: 'hyper' }], ['move', { coordinate: [1] }],
    ['key', { key: 'not-a-key' }], ['key', { key: 'tab', repeat: 11 }], ['key', {}], ['type', { text: 'caf\u00e9' }], ['type', { text: '' }], ['type', { text: 'a'.repeat(513) }], ['type', { text: 'a\nb' }],
    ['scroll', { direction: 'left' }], ['scroll', { direction: 'up', amount: 11 }], ['screenshot', { extra: 1 }], ['type', 'text'], ['type', null],
  ];
  for (const [name, args] of bad) {
    const { call, client } = setup(); // a fresh server each time: repeated failures would halt it
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(result.content[0].text, 'Invalid arguments.');
    assert.equal(client.inputs.length + client.captures.length, 0, `${name} ${JSON.stringify(args)}`);
  }
});

test('client failures: only the fixed code is shown; an unknown outcome says so; the Broker\'s own reason never reaches the model', async () => {
  const { call, client } = setup();
  client.failNext('desktop_broker_timeout', 'unknown');
  const unknown = await call('key', { key: 'return' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /desktop_broker_timeout/u);
  assert.match(unknown.content[0].text, /may or may not/u);
  client.failNext('desktop_unavailable', 'not_applied');
  const notApplied = await call('key', { key: 'return' });
  assert.doesNotMatch(notApplied.content[0].text, /may or may not/u);
  client.failNext('desktop_unavailable', 'unknown');
  const shot = await call('screenshot');
  assert.equal(shot.content.length, 1);
  assert.doesNotMatch(JSON.stringify([unknown, notApplied, shot]), /transport_error|brokerCode|denied/u);
});

// ---- budget ----

test('budget: calls beyond maxCalls are refused without reaching the client; invalid calls and screenshots count', async () => {
  const { call, client, server } = setup({ maxCalls: 3 });
  await call('screenshot');
  await call('click', { coordinate: [-5, 5] }); // invalid, still counted
  await call('key', { key: 'return' });
  for (let i = 0; i < 3; i += 1) {
    const refused = await call('key', { key: 'return' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /call_limit_reached/u);
  }
  assert.equal(client.inputs.length, 1);
  assert.equal(client.captures.length, 1);
  assert.equal(server.calls(), 3);
});

test('budget: after expiresAtMs every call is refused, even a screenshot', async () => {
  const { call, client, now } = setup({ expiresAtMs: NOW + 1000 });
  assert.equal((await call('screenshot')).isError, false);
  now.t = NOW + 1000;
  const refused = await call('screenshot');
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /time_limit_reached/u);
  assert.equal(client.captures.length, 1);
});

test('failures: three in a row halt the server for good; a success in between resets the count', async () => {
  const { call, client } = setup();
  client.expireLeases(); // the Broker no longer holds the lease: input is denied
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i += 1) assert.equal((await call('key', { key: 'return' })).isError, true);
  assert.equal((await call('screenshot')).isError, false); // a capture works: the count resets
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) assert.match((await call('key', { key: 'return' })).content[0].text, /desktop_unavailable/u);
  const captures = client.captures.length;
  const halted = await call('screenshot');
  assert.match(halted.content[0].text, /halted_after_repeated_failures/u);
  assert.equal(client.captures.length, captures);
});

test('server options: a client without the two methods, a bad computer id, an unusable screen and bad limits are refused', () => {
  const client = createFakeDesktopBrokerClient();
  const ok = { client, computerId: 'computer-1', operationId: 'op-1', screen: SCREEN, maxCalls: 1, expiresAtMs: 1 };
  assert.throws(() => createDesktopMcpServer({ ...ok, client: {} }), TypeError);
  assert.throws(() => createDesktopMcpServer({ ...ok, computerId: 'bad id' }), (e) => e.code === 'desktop_vm_not_found');
  assert.throws(() => createDesktopMcpServer({ ...ok, screen: { width: 10, height: 10 } }), TypeError);
  assert.throws(() => createDesktopMcpServer({ ...ok, maxCalls: 0 }), TypeError);
});

// ---- stdio ----

test('stdio: line-delimited JSON in order; a bad line gets a parse error and the server goes on; it ends when stdin ends', async () => {
  const { server } = setup();
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => lines.push(...chunk.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  const served = serveDesktopMcp({ server, input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write('not json\n');
  input.write('\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"screenshot","arguments":{}}}\n');
  input.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
  input.end();
  await served;
  assert.deepEqual(lines.map((l) => l.id), [1, null, 2, 3]);
  assert.equal(lines[1].error.code, -32700);
  assert.equal(lines[2].result.content[0].type, 'image');
});

// ---- entry ----

test('entry: bad flags exit 2 with a fixed line that echoes nothing from the command line; no broker flags is refused too', async () => {
  for (const argv of [['--nope', 'SECRET-VALUE'], ['--computer', 'computer-1', '--operation', 'op-1', '--max-calls', '1', '--expires-at', '9']]) {
    const err = [];
    const code = await runDesktopMcpEntry({ argv, stdin: new PassThrough(), stdout: new PassThrough(), stderr: { write: (s) => err.push(s) }, createClient: () => { throw new Error('must not be called'); } });
    assert.equal(code, 2);
    assert.deepEqual(err, [`${MCP_ENTRY_ERRORS.args}\n`]);
  }
});

test('entry: builds the client from the flags (service-name expectation, pinned helper), serves, and closes the client at the end', async () => {
  const fake = createFakeDesktopBrokerClient();
  fake.grantLease('computer-1', 'op-1');
  let made = null;
  let closed = false;
  const createClient = (options) => { made = options; return { ...fake, close: async () => { closed = true; } }; };
  const argv = buildDesktopMcpArgs({ entryPath: 'ignored', computerId: 'computer-1', operationId: 'op-1', maxCalls: 5, expiresAtMs: Date.now() + 60_000,
    broker: { pipeName: 'pipe-1', serviceName: 'Svc-1', helperPath: 'C:\\h\\helper.exe', helperSha256: HASH } }).slice(1);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out = [];
  stdout.on('data', (chunk) => out.push(chunk.toString('utf8')));
  const done = runDesktopMcpEntry({ argv, stdin, stdout, stderr: { write() {} }, createClient });
  stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"key","arguments":{"key":"return"}}}\n');
  stdin.end();
  assert.equal(await done, 0);
  assert.deepEqual(made, { pipeName: 'pipe-1', expect: { serviceName: 'Svc-1' }, helperPath: 'C:\\h\\helper.exe', helperSha256: HASH });
  assert.equal(JSON.parse(out.join('')).result.isError, false);
  assert.equal(fake.inputs.length, 1);
  assert.equal(closed, true);
});

test('entry: a client the Broker module refuses exits 2 with the broker line', async () => {
  const err = [];
  const argv = buildDesktopMcpArgs({ entryPath: 'ignored', computerId: 'computer-1', operationId: 'op-1', maxCalls: 5, expiresAtMs: 99,
    broker: { pipeName: 'pipe-1', serviceName: 'Svc-1', helperPath: 'C:\\h\\helper.exe', helperSha256: HASH } }).slice(1);
  const code = await runDesktopMcpEntry({ argv, stdin: new PassThrough(), stdout: new PassThrough(), stderr: { write: (s) => err.push(s) }, createClient: () => { throw new TypeError('invalid_desktop_broker_client_options'); } });
  assert.equal(code, 2);
  assert.deepEqual(err, [`${MCP_ENTRY_ERRORS.broker}\n`]);
});
