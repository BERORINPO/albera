import { createWindowsDesktopBrokerClient } from './windows-desktop-broker-client.mjs';
import { parseDesktopMcpArgs } from './albera-desktop-mcp-args.mjs';
import { createDesktopMcpServer, serveDesktopMcp } from './albera-desktop-mcp-server.mjs';

// Entry of the ALBERA desktop MCP server, started as `node albera-desktop-mcp-main.mjs --computer <id> --operation <id> ...` (flags: albera-desktop-mcp-args.mjs). Claude Code starts it as a stdio MCP
// server from the config the driver writes; nobody runs it by hand. Wiring only: it builds the real desktop Broker client from the flags and serves stdin/stdout. Every decision is in the
// server module. Errors are fixed lines on stderr (never a value from the command line) and exit code 2; Claude Code discards stderr.

export const MCP_ENTRY_ERRORS = Object.freeze({ args: 'albera_desktop_mcp_invalid_args', broker: 'albera_desktop_mcp_broker_unavailable' });

/**
 * @param {{ argv: string[], stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: { write: Function }, createClient?: Function, now?: () => number }} io
 * @returns {Promise<number>} the exit code
 */
export async function runDesktopMcpEntry({ argv, stdin, stdout, stderr, createClient = createWindowsDesktopBrokerClient, now = Date.now }) {
  let client;
  let server;
  try {
    const args = parseDesktopMcpArgs(argv);
    if (args.broker === null) throw new TypeError('no_broker');
    client = createClient({ pipeName: args.broker.pipeName, expect: { serviceName: args.broker.serviceName }, helperPath: args.broker.helperPath, helperSha256: args.broker.helperSha256 });
    server = createDesktopMcpServer({ client, computerId: args.computerId, operationId: args.operationId, leaseGeneration: args.leaseGeneration, screen: args.screen, maxCalls: args.maxCalls, expiresAtMs: args.expiresAtMs, now });
  } catch (error) {
    stderr.write(`${error?.message === 'invalid_desktop_mcp_args' || error?.message === 'no_broker' ? MCP_ENTRY_ERRORS.args : MCP_ENTRY_ERRORS.broker}\n`);
    await Promise.resolve(client?.close?.()).catch(() => {});
    return 2;
  }
  try {
    await serveDesktopMcp({ server, input: stdin, output: stdout });
    return 0;
  } finally {
    await client.close().catch(() => {}); // the helper processes end with the server
  }
}
