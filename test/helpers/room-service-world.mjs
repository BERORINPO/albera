// A world for the tests of `room-service` (src/runtime/room-service-wiring.mjs): a data root in a temp folder with the two settings files, Fakes for everything outside the process
// (the approval pipes and the flow's journal, the desktop client, the DPAPI secret store, the bootstrap file), and the Fake claude (src/runtime/fake-claude-code.mjs) as the "claude" executable.
// Nothing here opens a pipe, a service, a real claude, a VM or DPAPI. The secrets are obvious test strings.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeDriver } from '../../src/runtime/claude-code-driver.mjs';
import { createMemoryFlowJournal } from '../../src/runtime/approved-operation-journal.mjs';
import { captureExecutableIdentity } from '../../src/runtime/executable-identity.mjs';
import { createFakeBootstrapStore } from '../../src/runtime/fake-room-bootstrap-file.mjs';
import { createFakeControlPlaneSecretStore } from '../../src/runtime/fake-control-plane-secret-store.mjs';
import { createFakeDesktopBrokerClient } from '../../src/runtime/fake-desktop-broker-client.mjs';
import { roomServicePaths } from '../../src/runtime/room-service-config.mjs';
import { startRoomService } from '../../src/runtime/room-service-wiring.mjs';
import { createTestAuthority, signedReceipt, stableUuid } from '../../scripts/issue-22-approval-authority-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.resolve(here, '../../src/runtime/fake-claude-code.mjs');
export const FAKE_MCP_MAIN = path.resolve(here, '../../src/runtime/fake-albera-desktop-mcp-main.mjs');
export const TEST_TOKEN = 'TEST-ONLY-oauth-token-0123456789abcdef';
export const CP_SID = 'S-1-5-80-1111111111-2222222222-3333333333-4444444444-5555555555';
export const OWNER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001';
export const COMPUTERS = Object.freeze({ 'albera-computer-a': 'computer-a', 'albera-computer-b': 'computer-b' });
export const PROJECT_ID = 'project-1';
const HELPER_SHA = 'e'.repeat(64);
let nodeSha;
const nodeSha256 = async () => (nodeSha ??= (await captureExecutableIdentity(process.execPath)).sha256);
export const settle = (ms = 25) => new Promise((resolve) => { setTimeout(resolve, ms); });
export async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(20);
  }
}

/** The approval side: the pipe clients as fakes that record what they were given. A person is simulated by `world.approved` (false = the Authority keeps answering `pending`). */
function approvalWorld(desktop) {
  const authority = createTestAuthority();
  const world = {
    clock: 1_800_000_000_000, approved: true, denyWith: null, calls: [], submissions: [], claims: [], fields: new Map(), journal: createMemoryFlowJournal(), stores: 0, storeClosed: 0, desktopClosed: 0,
  };
  const seconds = () => Math.floor(world.clock / 1000);
  world.deps = {
    async sendBrokerFence(options) { world.calls.push(['fence', options]); return { ok: true, brokerEpoch: 1, leaseGeneration: 7, leaseId: 'lease-1', brokerChallenge: randomBytes(16).toString('base64url') }; },
    async sendBrokerRequest(options) { world.calls.push(['claim', options]); world.claims.push(options); return { ok: true, state: 'UNKNOWN', action: options.action?.action }; },
    async sendBrokerInspect(options) { world.calls.push(['inspect', options]); return { ok: false, code: 'denied' }; },
    async submitApproval(options) {
      world.calls.push(['submit', options]);
      world.submissions.push(options);
      const approvalId = stableUuid(`${options.operationId}/${options.idempotencyKey}`);
      world.fields.set(approvalId, options);
      return { ok: true, approvalId, state: 'pending', expiresAt: seconds() + 3600 };
    },
    async getApprovalStatus(options) {
      world.calls.push(['status', options]);
      if (world.denyWith) return { ok: false, code: world.denyWith };
      if (!world.approved) return { ok: true, state: 'pending', expiresAt: seconds() + 3600 };
      const f = world.fields.get(options.approvalId);
      return {
        ok: true, state: 'approved',
        ...signedReceipt({
          authority, name: f.idempotencyKey, now: seconds(), ttlSeconds: 120, approvalId: options.approvalId, operationId: f.operationId, idempotencyKey: f.idempotencyKey,
          leaseId: f.leaseId, projectId: f.action.projectId, computerId: f.action.computerId,
          fence: { brokerEpoch: f.brokerEpoch, leaseGeneration: f.leaseGeneration, brokerChallenge: f.brokerChallenge },
          purpose: f.purpose, action: f.action.action, args: f.action.args,
        }),
      };
    },
    async openStore() { world.stores += 1; return { flowJournal: () => world.journal, close: () => { world.storeClosed += 1; } }; },
    createDesktopClient() { return { captureVmScreen: (r) => desktop.captureVmScreen(r), sendVmInput: (r) => desktop.sendVmInput(r), close: async () => { world.desktopClosed += 1; await desktop.close(); } }; },
    newOperationId: (() => { let n = 0; return () => `room-start-${(n += 1)}`; })(),
    now: () => world.clock,
    sleep: () => settle(5), // a real (short) wait: a fake that returns at once would starve the HTTP server while the flow polls
  };
  return world;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ script?: object, settingsPatch?: object, servicePatch?: object, token?: string|null }} [options] `script` = the Fake claude's script (default: one screenshot, then DONE)
 */
export async function makeServiceWorld(t, { script = { steps: [{ tool: 'screenshot' }, { result: 'DONE: finished' }] }, settingsPatch = {}, servicePatch = {}, token = TEST_TOKEN } = {}) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-rs-')));
  const closers = []; // services started by world.start(): closed before the folder goes (t.after hooks run in the order they were registered)
  t.after(async () => { for (const close of closers) await close().catch(() => {}); rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const dataRoot = path.join(base, 'Albera');
  const paths = roomServicePaths(dataRoot);
  mkdirSync(path.dirname(paths.serviceConfig), { recursive: true });
  const recordTo = path.join(base, 'claude-record.json');
  const scriptFile = path.join(base, 'claude-script.json');
  writeFileSync(scriptFile, JSON.stringify({ recordTo, ...script }));
  const approvalSettings = {
    version: 1, projectId: PROJECT_ID,
    broker: { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' } },
    authority: { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: { serviceName: 'AlberaApprovalAuthority' } },
    journal: path.join(dataRoot, 'control-plane', 'operations.sqlite'), computers: COMPUTERS,
    desktop: { helperPath: path.join(dataRoot, 'bin', 'pipe-client.exe'), helperSha256: HELPER_SHA }, attestation: null, ...settingsPatch,
  };
  const service = {
    host: { nodePath: process.execPath }, // the .NET host's key: the room does not read it
    claude: { executable: process.execPath, executableSha256: await nodeSha256(), maxMinutes: 5, maxToolCalls: 20 },
    ui: { controlPlaneSid: CP_SID, approverSid: OWNER_SID }, ...servicePatch,
  };
  writeFileSync(paths.approvalFile, JSON.stringify(approvalSettings));
  writeFileSync(paths.serviceConfig, JSON.stringify(service));

  const desktop = createFakeDesktopBrokerClient({ computers: ['computer-a', 'computer-b'] });
  const approval = approvalWorld(desktop);
  const secretStore = createFakeControlPlaneSecretStore();
  if (token !== null) await secretStore.save('claude-oauth-token', token);
  const bootstrap = createFakeBootstrapStore();
  const logs = [];
  const driverSeen = []; // what each driver was given (read before it started): { configDir, workDir, configEntries, workEntries }
  const deps = {
    approvalDeps: approval.deps, secretStore, createBootstrapStore: () => bootstrap, mcpEntryPath: FAKE_MCP_MAIN, log: (line) => logs.push(line),
    captureIntervalMs: 60_000, tickMs: 60_000,
    createDriver: (options) => { // the real driver, after a look at the two folders it was handed
      driverSeen.push({ configDir: options.configDir, workDir: options.workDir, configEntries: readdirSync(options.configDir), workEntries: readdirSync(options.workDir), oauthToken: options.oauthToken, mcpServer: options.mcpServer });
      return createClaudeCodeDriver(options);
    },
    driverOptions: { executableArgs: [FAKE_CLAUDE, scriptFile], io: { exists: async () => false }, exitGraceMs: 3000 }, // the real home above a temp folder may hold a CLAUDE.md
  };
  const world = {
    base, dataRoot, paths, approval, secretStore, bootstrap, logs, deps, desktop, driverSeen, scriptFile, recordTo,
    record: () => JSON.parse(readFileSync(recordTo, 'utf8')),
    /** Close this service before the data root is removed. */
    track(service) { closers.push(() => service.close()); return service; },
    async start(extra = {}) {
      const started = await startRoomService({ dataRoot }, { ...deps, ...extra });
      world.track(started);
      return started;
    },
    /** The page's side: read ui\room.json like "Open ALBERA" does, post the code to /api/session, and send what the page sends. */
    async open() {
      const file = await until(() => bootstrap.read(paths.uiFile), 'ui\\room.json');
      const origin = `http://127.0.0.1:${file.port}`;
      const res = await fetch(`${origin}/room/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ bootstrapCode: file.code }) });
      const cookie = res.status === 200 ? res.headers.get('set-cookie').split(';')[0] : null;
      async function call(method, route, body) {
        const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) };
        const r = await fetch(`${origin}/room/${route}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, text, json };
      }
      return { file, origin, unlocked: res.status, call };
    },
  };
  return world;
}
