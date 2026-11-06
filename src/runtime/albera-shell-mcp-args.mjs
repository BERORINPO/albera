import { ID_PATTERN } from './broker-contract/action-digest.mjs';
import { isAbsolutePath, MAX_MCP_CALLS } from './albera-desktop-mcp-args.mjs';

// Command line of the ALBERA shell MCP server (albera-shell-mcp.mjs), one definition for the entry that parses it and the caller that builds it. The driver appends the two limit flags
// (`desktopMcpLimitArgs`, the same two flags for both servers). Pure: no process, file or clock access.
//
// The run is fixed HERE, on the server's command line, because the driver writes it into the MCP config that Claude Code starts the server from. Nothing a tool call carries can change it.
//
//   --operation <id>                  the approved task.start operationId, which is the run id at the bridge (required)
//   --max-calls <n>                   tool calls the server will answer before it refuses (required)
//   --expires-at <epoch ms>           after this instant it refuses every call (required)
//   --pipe-name <name> --server-sid <sid> --helper <absolute path> --helper-sha256 <64 hex>
//                                     the bridge's pipe, the SID it must run as, and the pinned pipe client helper; all four or none (none = a test entry that brings its own client)
//   --server-image-sha256 <64 hex>    optional, with the four above: the image the server process must be
// Names, paths, a SID and public hashes only. No secret and no lease is given here: the hands call `begin` with the lease before Claude Code starts, and this server can only reach a run that already exists.

const ID_RE = new RegExp(ID_PATTERN, 'u');
const PIPE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const SID_RE = /^S-1-\d{1,10}(?:-\d{1,10}){1,15}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const INT_RE = /^[0-9]{1,16}$/u;
const BRIDGE_FLAGS = Object.freeze(['--pipe-name', '--server-sid', '--helper', '--helper-sha256']);
const FLAGS = Object.freeze(['--operation', '--max-calls', '--expires-at', '--server-image-sha256', ...BRIDGE_FLAGS]);
const fail = () => new TypeError('invalid_shell_mcp_args');

/**
 * Everything of the server's command line but the limits (after `node`): `entryPath` first, then the flags. `bridge` is `{ pipeName, serverSid, serverImageSha256?, helperPath, helperSha256 }` or absent.
 * Validates by parsing the list with stand-in limits, so a value the entry would refuse is refused here.
 */
export function buildShellMcpFlags({ entryPath, operationId, bridge = null }) {
  const args = ['--operation', operationId, ...(bridge === null ? [] : ['--pipe-name', bridge.pipeName, '--server-sid', bridge.serverSid, '--helper', bridge.helperPath, '--helper-sha256', bridge.helperSha256,
    ...(bridge.serverImageSha256 === undefined ? [] : ['--server-image-sha256', bridge.serverImageSha256])])];
  parseShellMcpArgs([...args, '--max-calls', '1', '--expires-at', '1']);
  return [entryPath, ...args];
}

/**
 * Strict parse: only the known flags, each once, each with a value. Throws TypeError('invalid_shell_mcp_args') without echoing any value.
 * @returns {{ operationId: string, maxCalls: number, expiresAtMs: number, bridge: { pipeName: string, serverSid: string, serverImageSha256: string|null, helperPath: string, helperSha256: string }|null }}
 */
export function parseShellMcpArgs(argv) {
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
  const integer = (flag, max) => {
    const n = Number(wanted(flag, (v) => INT_RE.test(v)));
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw fail();
    return n;
  };
  const given = BRIDGE_FLAGS.filter((flag) => seen.has(flag));
  if (given.length !== 0 && given.length !== BRIDGE_FLAGS.length) throw fail();
  if (given.length === 0 && seen.has('--server-image-sha256')) throw fail();
  const bridge = given.length === 0 ? null : Object.freeze({
    pipeName: wanted('--pipe-name', (v) => PIPE_NAME_RE.test(v)),
    serverSid: wanted('--server-sid', (v) => SID_RE.test(v)),
    serverImageSha256: seen.has('--server-image-sha256') ? wanted('--server-image-sha256', (v) => SHA256_RE.test(v)) : null,
    helperPath: wanted('--helper', isAbsolutePath),
    helperSha256: wanted('--helper-sha256', (v) => SHA256_RE.test(v)),
  });
  return Object.freeze({
    operationId: wanted('--operation', (v) => ID_RE.test(v)), maxCalls: integer('--max-calls', MAX_MCP_CALLS), expiresAtMs: integer('--expires-at', Number.MAX_SAFE_INTEGER), bridge,
  });
}
