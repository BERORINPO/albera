import { ID_PATTERN } from './broker-contract/action-digest.mjs';

// Command line of the ALBERA desktop MCP server (albera-desktop-mcp.mjs), one definition for its three users: the entry that parses it, the driver that appends the limit flags, and the
// caller (the room) that builds the whole line. Pure: no process, file or clock access.
//
// The computer and the lease are fixed HERE, on the server's command line, because the driver writes them into the MCP config that Claude Code starts the server from. Nothing a tool call
// carries can change them (the tool schemas have no such field and reject unknown ones).
//
//   --computer <id>            the Broker's computerId (required)
//   --operation <id>           the approved task.start operationId = the desktop lease (required)
//   --lease-generation <n>     optional: the Broker's lease generation (without it the Broker joins the lease that is current for the operation)
//   --screen <W>x<H>           screen size asked of the Broker and the bound of every coordinate (default 1024x768)
//   --max-calls <n>            tool calls the server will answer before it refuses (required)
//   --expires-at <epoch ms>    after this instant it refuses every call (required)
//   --pipe-name <name> --service-name <name> --helper <absolute path> --helper-sha256 <64 hex>
//                              the Broker's desktop pipe and the pinned pipe client helper; all four or none (none = a test entry that brings its own client)
// Names, paths and public hashes only. No secret is ever given here: the OAuth token goes to Claude Code's environment, not to this server.

export const DEFAULT_MCP_SCREEN = Object.freeze({ width: 1024, height: 768 });
export const MAX_MCP_CALLS = 1000;

const ID_RE = new RegExp(ID_PATTERN, 'u');
const PIPE_NAME_RE = /^[A-Za-z0-9_-]{1,120}$/u;
const SERVICE_NAME_RE = /^[A-Za-z0-9_-]{1,256}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const INT_RE = /^[0-9]{1,16}$/u;
const SCREEN_RE = /^([0-9]{1,5})x([0-9]{1,5})$/u;
const FLAGS = Object.freeze(['--computer', '--operation', '--lease-generation', '--screen', '--max-calls', '--expires-at', '--pipe-name', '--service-name', '--helper', '--helper-sha256']);
const BROKER_FLAGS = Object.freeze(['--pipe-name', '--service-name', '--helper', '--helper-sha256']);
const fail = () => new TypeError('invalid_desktop_mcp_args');

// Absolute and normalized in the Windows or POSIX sense, not a UNC share.
const isAbsolutePath = (value) => typeof value === 'string' && value.length > 0 && !/^[\\/]{2}/u.test(value) && !/(?:^|[\\/])\.\.?(?:[\\/]|$)/u.test(value) && (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('/'));

/** The flags that bound a run, appended by the driver to whatever command line the caller built. */
export function desktopMcpLimitArgs({ maxCalls, expiresAtMs }) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_MCP_CALLS || !Number.isSafeInteger(expiresAtMs) || expiresAtMs < 1) throw fail();
  return ['--max-calls', String(maxCalls), '--expires-at', String(expiresAtMs)];
}

/**
 * The server's whole argument list (after `node`): `entryPath` first, then the flags. `broker` is `{ pipeName, serviceName, helperPath, helperSha256 }` or absent.
 * Validates by parsing the list it built, so a value the entry would refuse is refused here.
 */
export function buildDesktopMcpArgs({ entryPath, computerId, operationId, leaseGeneration = null, screen = DEFAULT_MCP_SCREEN, maxCalls, expiresAtMs, broker = null }) {
  const args = ['--computer', computerId, '--operation', operationId,
    ...(leaseGeneration === null ? [] : ['--lease-generation', String(leaseGeneration)]),
    '--screen', `${screen.width}x${screen.height}`, ...desktopMcpLimitArgs({ maxCalls, expiresAtMs }),
    ...(broker === null ? [] : ['--pipe-name', broker.pipeName, '--service-name', broker.serviceName, '--helper', broker.helperPath, '--helper-sha256', broker.helperSha256])];
  parseDesktopMcpArgs(args);
  return [entryPath, ...args];
}

/**
 * Strict parse: only the known flags, each once, each with a value. Throws TypeError('invalid_desktop_mcp_args') without echoing any value.
 * @returns {{ computerId: string, operationId: string, leaseGeneration: number|null, screen: { width: number, height: number }, maxCalls: number, expiresAtMs: number,
 *   broker: { pipeName: string, serviceName: string, helperPath: string, helperSha256: string }|null }}
 */
export function parseDesktopMcpArgs(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) throw fail();
  const seen = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!FLAGS.includes(flag) || seen.has(flag) || typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw fail();
    seen.set(flag, value);
  }
  const wanted = (flag, test) => {
    const value = seen.get(flag);
    if (value === undefined || !test(value)) throw fail();
    return value;
  };
  const integer = (flag, min, max) => {
    const value = wanted(flag, (v) => INT_RE.test(v));
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw fail();
    return n;
  };
  const computerId = wanted('--computer', (v) => ID_RE.test(v));
  const operationId = wanted('--operation', (v) => ID_RE.test(v));
  const leaseGeneration = seen.has('--lease-generation') ? integer('--lease-generation', 1, Number.MAX_SAFE_INTEGER) : null;
  const maxCalls = integer('--max-calls', 1, MAX_MCP_CALLS);
  const expiresAtMs = integer('--expires-at', 1, Number.MAX_SAFE_INTEGER);
  let screen = DEFAULT_MCP_SCREEN;
  if (seen.has('--screen')) {
    const match = wanted('--screen', (v) => SCREEN_RE.test(v)).match(SCREEN_RE);
    screen = Object.freeze({ width: Number(match[1]), height: Number(match[2]) });
    if (screen.width < 1 || screen.height < 1 || screen.width > 4096 || screen.height > 4096) throw fail(); // the server applies the Broker's tighter capture bounds
  }
  const given = BROKER_FLAGS.filter((flag) => seen.has(flag));
  if (given.length !== 0 && given.length !== BROKER_FLAGS.length) throw fail();
  const broker = given.length === 0 ? null : Object.freeze({
    pipeName: wanted('--pipe-name', (v) => PIPE_NAME_RE.test(v)),
    serviceName: wanted('--service-name', (v) => SERVICE_NAME_RE.test(v)),
    helperPath: wanted('--helper', isAbsolutePath),
    helperSha256: wanted('--helper-sha256', (v) => SHA256_RE.test(v)),
  });
  return Object.freeze({ computerId, operationId, leaseGeneration, screen, maxCalls, expiresAtMs, broker });
}
