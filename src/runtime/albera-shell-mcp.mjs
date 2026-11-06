import { scrubCredentialEnvironment } from './albera-desktop-mcp.mjs';
import { serveDesktopMcp } from './albera-desktop-mcp-server.mjs';
import { parseShellMcpArgs } from './albera-shell-mcp-args.mjs';
import { createShellMcpServer } from './albera-shell-mcp-server.mjs';
import { createWsl2BridgeClient } from './wsl2-bridge-client.mjs';

// Entry of the ALBERA shell MCP server, started as `node albera-shell-mcp-main.mjs --operation <id> ...` (flags: albera-shell-mcp-args.mjs). Claude Code starts it as a stdio MCP server from the config the driver
// writes; nobody runs it by hand. Wiring only: it builds the real bridge client from the flags and serves stdin/stdout. Every decision is in the server module. The line protocol is the desktop server's
// (`serveDesktopMcp` knows nothing of the desktop). Errors are fixed lines on stderr (never a value from the command line) and exit code 2; Claude Code discards stderr.

export const SHELL_MCP_ENTRY_ERRORS = Object.freeze({ args: 'albera_shell_mcp_invalid_args', bridge: 'albera_shell_mcp_bridge_unavailable' });

/**
 * @param {{ argv: string[], stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: { write: Function }, createClient?: Function, createServer?: Function, now?: () => number, env?: object }} io
 * @returns {Promise<number>} the exit code
 */
export async function runShellMcpEntry({ argv, stdin, stdout, stderr, createClient = createWsl2BridgeClient, createServer = createShellMcpServer, now = Date.now, env = process.env }) {
  scrubCredentialEnvironment(env); // the token may be in the environment Claude Code hands down (NOT VERIFIED, M11); this server needs none
  let server;
  try {
    const args = parseShellMcpArgs(argv);
    if (args.bridge === null) throw new TypeError('no_bridge');
    const { run, put, get } = createClient(args.bridge); // begin, end and stop stay out of this process's server: they are the hands' (ADR-012, Phase 3 results)
    server = createServer({ client: Object.freeze({ run, put, get }), operationId: args.operationId, maxCalls: args.maxCalls, expiresAtMs: args.expiresAtMs, now });
  } catch (error) {
    stderr.write(`${error?.message === 'invalid_shell_mcp_args' || error?.message === 'no_bridge' ? SHELL_MCP_ENTRY_ERRORS.args : SHELL_MCP_ENTRY_ERRORS.bridge}\n`);
    return 2;
  }
  await serveDesktopMcp({ server, input: stdin, output: stdout });
  return 0;
}
