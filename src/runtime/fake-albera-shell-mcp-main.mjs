import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { serveDesktopMcp } from './albera-desktop-mcp-server.mjs';
import { parseShellMcpArgs } from './albera-shell-mcp-args.mjs';
import { createShellMcpServer } from './albera-shell-mcp-server.mjs';
import { createFakeWsl2BridgeClient } from './fake-wsl2-bridge-client.mjs';

// Fake of albera-shell-mcp-main.mjs, for tests that start the MCP server as a real child process (with fake-claude-code.mjs): the same flags and the same server module, but the Fake bridge client (no pipe,
// no helper, no WSL). Every call the server forwards is appended, one JSON line each, to <TEMP>/mcp-calls.jsonl, so a test can see what reached the "bridge". The bridge flags are accepted and ignored.
const args = parseShellMcpArgs(process.argv.slice(2));
const fake = createFakeWsl2BridgeClient();
const logFile = path.join(process.env.TEMP ?? process.env.TMPDIR, 'mcp-calls.jsonl');
const logged = (verb) => async (...request) => {
  const result = await fake[verb](...request);
  appendFileSync(logFile, `${JSON.stringify(fake.calls.at(-1))}\n`);
  return result;
};
const client = Object.freeze({ run: logged('run'), put: logged('put'), get: logged('get') });
const server = createShellMcpServer({ client, operationId: args.operationId, maxCalls: args.maxCalls, expiresAtMs: args.expiresAtMs });
await serveDesktopMcp({ server, input: process.stdin, output: process.stdout });
