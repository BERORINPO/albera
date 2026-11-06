import { isSafeRunPath } from './wsl2-bridge-wire.mjs';

// In-memory Fake of the bridge client (wsl2-bridge-client.mjs) for tests of the shell MCP server: no pipe, no helper, no WSL. Files are a map, a command answers what `onExec` says, and every call is
// recorded in `calls`. `failNext({ code, outcome })` makes the next call fail the way the real client does. A green test with this Fake says nothing about the real bridge.

/** @param {{ onExec?: (request: { seconds: number, command: string }) => (object|Promise<object>) }} [options] */
export function createFakeWsl2BridgeClient({ onExec = ({ command }) => ({ exitCode: 0, flags: 0, output: Buffer.from(`ran: ${command}\n`, 'utf8') }) } = {}) {
  const files = new Map();
  const calls = [];
  let nextFailure = null;

  const failure = () => {
    if (nextFailure === null) return;
    const { code, outcome = 'refused' } = nextFailure;
    nextFailure = null;
    throw Object.assign(new Error(code), { code, outcome });
  };

  return Object.freeze({
    calls,
    files,
    failNext(error) { nextFailure = error; },
    async run(runId, { seconds, command }) { calls.push({ verb: 'run', runId, seconds, command }); failure(); return onExec({ seconds, command }); },
    async put(runId, path, data) {
      calls.push({ verb: 'put', runId, path, bytes: Buffer.byteLength(data) });
      failure();
      if (!isSafeRunPath(path)) throw Object.assign(new Error('bad_path'), { code: 'bad_path', outcome: 'refused' });
      files.set(path, Buffer.from(data));
      return {};
    },
    async get(runId, path) {
      calls.push({ verb: 'get', runId, path });
      failure();
      if (!files.has(path)) throw Object.assign(new Error('agent_file_error'), { code: 'agent_file_error', outcome: 'refused' });
      return { data: files.get(path) };
    },
  });
}
