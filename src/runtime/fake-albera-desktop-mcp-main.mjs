import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { parseDesktopMcpArgs } from './albera-desktop-mcp-args.mjs';
import { createDesktopMcpServer, serveDesktopMcp } from './albera-desktop-mcp-server.mjs';
import { createFakeDesktopBrokerClient } from './fake-desktop-broker-client.mjs';

// Fake of albera-desktop-mcp-main.mjs, for tests that start the MCP server as a real child process (with fake-claude-code.mjs): the same flags and the same server module, but the Fake
// desktop Broker client (no pipe, no helper, no VM). Every capture and input the server forwards is appended, one JSON line each, to <TEMP>/mcp-calls.jsonl, so a test can see what reached
// the "Broker". The broker flags are accepted and ignored.
const args = parseDesktopMcpArgs(process.argv.slice(2));
const fake = createFakeDesktopBrokerClient({ computers: [args.computerId] });
fake.grantLease(args.computerId, args.operationId);
const logFile = path.join(process.env.TEMP ?? process.env.TMPDIR, 'mcp-calls.jsonl');
const log = (entry) => appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
const client = Object.freeze({
  captureVmScreen: async (request) => { log({ capture: request }); return fake.captureVmScreen(request); },
  sendVmInput: async (request) => { log({ input: { vmId: request.vmId, action: request.action, lease: request.lease } }); return fake.sendVmInput(request); },
  close: async () => {},
});
const server = createDesktopMcpServer({ client, computerId: args.computerId, operationId: args.operationId, leaseGeneration: args.leaseGeneration, screen: args.screen, maxCalls: args.maxCalls, expiresAtMs: args.expiresAtMs });
await serveDesktopMcp({ server, input: process.stdin, output: process.stdout });
