import { createInterface } from 'node:readline';
import { validateDesktopAction } from './desktop-control.mjs';
import { checkCaptureRequest, DESKTOP_BROKER_LIMITS, readPngHeader } from './desktop-broker-client-contract.mjs';
import { DEFAULT_MCP_SCREEN } from './albera-desktop-mcp-args.mjs';

// ALBERA desktop MCP server: a minimal Model Context Protocol server (JSON-RPC 2.0, one JSON object per line over stdio, no SDK) that gives Claude Code a screen and a keyboard/mouse on ONE
// computer. It is an adapter: the only thing it reaches is the injected desktop Broker client (windows-desktop-broker-client.mjs, or its Fake) through `captureVmScreen` / `sendVmInput`.
//
// What a tool call cannot do:
//   - choose the computer or the lease: both are fixed at start (albera-desktop-mcp-args.mjs); the schemas have no such field and unknown properties are refused;
//   - send an action the room's driver would refuse: every action goes through `validateDesktopAction` against the screen (coordinates, key names, ASCII text up to 512, repeat/scroll/
//     modifier bounds), the same function HyperVDesktopDriver uses, before it reaches the client;
//   - exceed the budget: `maxCalls` answered calls and the `expiresAtMs` instant bound the server on its own, even if the process that started it has gone away. A refused call is
//     not forwarded; three failed calls in a row end the server's willingness to try (a lease the Broker no longer holds does not come back).
// The Broker's own refusal reasons never reach the model: a client error is shown as its fixed `code` only. Screen contents are untrusted input (ADR-009): this server only forwards the PNG.

export const MCP_SERVER_NAME = 'albera_desktop';
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
export const MAX_CONSECUTIVE_FAILURES = 3;
const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_LINE_CHARS = 1024 * 1024;
const COORDINATE = Object.freeze({ type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 2, maxItems: 2, description: '[x, y] in screenshot pixels, origin at the top-left.' });
const MODIFIERS = Object.freeze({ type: 'string', description: 'Keys held during the action: ctrl, alt, shift, super, joined by "+" (for example "ctrl+shift").' });
const schema = (properties, required = []) => Object.freeze({ type: 'object', properties, required, additionalProperties: false });
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const CLICKS = Object.freeze({ left: ['left_click', 'double_click', 'triple_click'], right: ['right_click'], middle: ['middle_click'] });

/** name -> { description, inputSchema, toAction }. `toAction` makes the ALBERA action of a call's arguments (validated again by validateDesktopAction). */
const TOOLS = Object.freeze([
  { name: 'screenshot', description: 'Take a screenshot of the computer screen. Returns the image. Coordinates of the other tools are pixels of this image.', inputSchema: schema({}), toAction: () => ({ action: 'screenshot' }) },
  {
    name: 'click', description: 'Click the mouse at a point. Use clicks 2 or 3 (left button only) for a double or triple click.',
    inputSchema: schema({ coordinate: COORDINATE, button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' }, clicks: { type: 'integer', enum: [1, 2, 3], default: 1 }, modifiers: MODIFIERS }, ['coordinate']),
    toAction: (a) => {
      const kinds = CLICKS[a.button ?? 'left'];
      const clicks = a.clicks ?? 1;
      if (kinds === undefined || !Number.isInteger(clicks) || clicks < 1 || clicks > kinds.length) throw new TypeError('invalid_arguments');
      return { action: kinds[clicks - 1], coordinate: a.coordinate, ...(a.modifiers === undefined ? {} : { modifiers: a.modifiers }) };
    },
  },
  { name: 'move', description: 'Move the mouse pointer to a point without clicking.', inputSchema: schema({ coordinate: COORDINATE }, ['coordinate']), toAction: (a) => ({ action: 'mouse_move', coordinate: a.coordinate }) },
  {
    name: 'key', description: 'Press a key or a key combination, for example "return", "tab", "escape", "ctrl+c", "alt+f4". Named keys: return, enter, escape, tab, backspace, delete, space, arrows, home, end, page_up, page_down, insert, f1-f12; single letters, digits and punctuation.',
    inputSchema: schema({ key: { type: 'string' }, repeat: { type: 'integer', minimum: 1, maximum: 10 } }, ['key']),
    toAction: (a) => ({ action: 'key', key: a.key, ...(a.repeat === undefined ? {} : { repeat: a.repeat }) }),
  },
  {
    name: 'type', description: 'Type text at the keyboard focus. Printable ASCII only, 1 to 512 characters (no new line: use the key tool with "return").',
    inputSchema: schema({ text: { type: 'string', minLength: 1, maxLength: 512 } }, ['text']), toAction: (a) => ({ action: 'type', text: a.text }),
  },
  {
    name: 'scroll', description: 'Scroll the mouse wheel up or down, optionally at a point.',
    inputSchema: schema({ direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'integer', minimum: 1, maximum: 10, default: 3 }, coordinate: COORDINATE, modifiers: MODIFIERS }, ['direction']),
    toAction: (a) => ({ action: 'scroll', direction: a.direction, ...(a.amount === undefined ? {} : { amount: a.amount }), ...(a.coordinate === undefined ? {} : { coordinate: a.coordinate }), ...(a.modifiers === undefined ? {} : { modifiers: a.modifiers }) }),
  },
]);
export const DESKTOP_TOOL_NAMES = Object.freeze(TOOLS.map((tool) => tool.name));
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
const safeCode = (error) => (typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/u.test(error.code) ? error.code : 'desktop_error');
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * @param {{ client: { captureVmScreen: Function, sendVmInput: Function }, computerId: string, operationId: string, leaseGeneration?: number|null,
 *   screen?: { width: number, height: number }, maxCalls: number, expiresAtMs: number, now?: () => number }} options
 * @returns {{ handle: (message: unknown) => Promise<object|null>, calls: () => number }} `handle` answers one JSON-RPC message (null for a notification)
 */
export function createDesktopMcpServer({ client, computerId, operationId, leaseGeneration = null, screen = DEFAULT_MCP_SCREEN, maxCalls, expiresAtMs, now = Date.now }) {
  if (!client || typeof client.captureVmScreen !== 'function' || typeof client.sendVmInput !== 'function') throw new TypeError('invalid_desktop_mcp_client');
  const checked = checkCaptureRequest({ vmId: computerId, width: screen.width, height: screen.height }); // the Broker's own bounds on a capture
  const size = Object.freeze({ width: checked.width, height: checked.height });
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || !Number.isSafeInteger(expiresAtMs)) throw new TypeError('invalid_desktop_mcp_limits');
  const lease = Object.freeze({ desktopSessionId: operationId, ...(leaseGeneration === null ? {} : { generation: leaseGeneration }) });
  let calls = 0;
  let failures = 0;

  async function capture() {
    const png = await client.captureVmScreen({ vmId: computerId, width: size.width, height: size.height });
    const shape = readPngHeader(png);
    if (shape?.width !== size.width || shape?.height !== size.height || png.length > DESKTOP_BROKER_LIMITS.maxPngBytes) throw Object.assign(new Error('invalid_screen_data'), { code: 'invalid_desktop_screen_data' });
    return { content: [{ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: `Screen ${size.width}x${size.height} pixels. Coordinates are pixels from the top-left corner.` }], isError: false };
  }

  async function perform(tool, args) {
    if (!isPlain(args) || Object.keys(args).some((key) => !Object.hasOwn(tool.inputSchema.properties, key))) return textResult('Invalid arguments.', true);
    let action;
    try { action = validateDesktopAction(tool.toAction(args), size); } catch { return textResult('Invalid arguments.', true); }
    try {
      if (action.action === 'screenshot') return await capture();
      await client.sendVmInput({ vmId: computerId, action, lease });
      return textResult('OK');
    } catch (error) {
      const note = error?.outcome === 'not_applied' ? '' : ' The input may or may not have been applied; take a screenshot to check.';
      return textResult(`Action failed: ${safeCode(error)}.${action.action === 'screenshot' ? '' : note}`, true);
    }
  }

  async function callTool(params) {
    const tool = TOOL_BY_NAME.get(params?.name);
    if (tool === undefined) return null;
    if (failures >= MAX_CONSECUTIVE_FAILURES) return textResult('halted_after_repeated_failures: the computer is not answering; stop and report FAILED.', true);
    if (calls >= maxCalls) return textResult('call_limit_reached: no more tool calls are allowed; stop and report.', true);
    if (now() >= expiresAtMs) return textResult('time_limit_reached: no more tool calls are allowed; stop and report.', true);
    calls += 1;
    const result = await perform(tool, params.arguments ?? {});
    failures = result.isError ? failures + 1 : 0;
    return result;
  }

  async function handle(message) {
    if (!isPlain(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(isPlain(message) ? message.id : null, -32600, 'invalid_request');
    const { id, method, params } = message;
    if (id === undefined) return null; // a notification (notifications/initialized, notifications/cancelled): never answered
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return { jsonrpc: '2.0', id, result: { protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: MCP_SERVER_NAME, version: '0.1.0' } } };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
    if (method === 'tools/call') {
      const result = await callTool(params);
      return result === null ? rpcError(id, -32602, 'unknown_tool') : { jsonrpc: '2.0', id, result };
    }
    return rpcError(id, -32601, 'method_not_found');
  }

  return Object.freeze({ handle, calls: () => calls });
}

/**
 * Serve `server` over line-delimited JSON on two streams. Messages are answered one at a time, in order. Resolves when `input` ends and the last answer is written.
 * @param {{ server: { handle: Function }, input: NodeJS.ReadableStream, output: NodeJS.WritableStream }} streams
 */
export function serveDesktopMcp({ server, input, output }) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const write = (message) => { if (message !== null) output.write(`${JSON.stringify(message)}\n`); };
  let queue = Promise.resolve();
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    queue = queue.then(async () => {
      if (line.length > MAX_LINE_CHARS) return write(rpcError(null, -32700, 'line_too_long'));
      let message;
      try { message = JSON.parse(line); } catch { return write(rpcError(null, -32700, 'parse_error')); }
      try { write(await server.handle(message)); } catch { write(rpcError(message?.id, -32603, 'internal_error')); }
      return undefined;
    });
  });
  return new Promise((resolve) => { lines.once('close', () => { void queue.then(resolve); }); });
}
