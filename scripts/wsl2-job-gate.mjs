// ADR-012 job gate, on the real machine: a WSL2 job through every real part except Claude Code. The real bridge (seam build), the real Broker (test-faults build, a throwaway attestation key), the real pipe client
// helper and sendBrokerRequest, the real bridge client, the real shell MCP server and runWsl2Job with the real quarantine. Two stand-ins, and the output says so: `guard` answers true, and `runDriver` is a small
// MCP client that speaks to the real albera-shell-mcp-main.mjs where Claude Code would. A measuring tool, not part of `npm test`. No token, no network, no real key, no CNG key: the Broker's key is a throwaway
// PKCS#8 file this process makes, and its public half is what the bridge trusts.
// Safety as in wsl2-bridge-gates.mjs: it NEVER runs `wsl --shutdown`, refuses to start when an albera-* distribution is there, unregisters only names it made (`created`), and records that the owner's distributions are unchanged.
//
// Usage: node scripts/wsl2-job-gate.mjs <image .tar> <empty folder>
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  brokerSession, buildBrokerWithTestSeams, buildPipeClient, createTestAuthority, currentUserSid, makeTrustedTempDirectory, standInService, startProcess, waitForExit, waitForLine, GENERATION, LEASE_CONFIG,
} from '../test/helpers/windows-broker-harness.mjs';
import { buildBridge } from '../test/helpers/wsl-bridge-harness.mjs';
import { createEcdsaAttestationSigner } from '../src/runtime/ecdsa-attestation-signer.mjs';
import { authenticateWsl2RunLease } from '../src/runtime/broker-contract/wsl2-run-lease.mjs';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { createGitQuarantine } from '../src/runtime/git-quarantine.mjs';
import { createWsl2BridgeClient } from '../src/runtime/wsl2-bridge-client.mjs';
import { runWsl2Job } from '../src/runtime/room-service-wsl2-run.mjs';
import { desktopMcpLimitArgs } from '../src/runtime/albera-desktop-mcp-args.mjs';
import { sendBrokerRequest } from '../src/runtime/windows-broker-client.mjs';

const [image, folder] = process.argv.slice(2);
if (!image || !folder) { console.error('usage: wsl2-job-gate.mjs <image .tar> <folder>'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const env = { ...process.env, WSL_UTF8: '1' };
const wsl = (...args) => spawnSync('wsl.exe', args, { encoding: 'utf8', env });
const distributions = () => wsl('--list', '--quiet').stdout.split(/\r?\n/u).map((x) => x.replace(/^\uFEFF/u, '').replace(/ \(Default\)$/u, '').trim()).filter(Boolean);
const overview = () => wsl('--list', '--verbose').stdout.replace(/\*/gu, ' ').replace(/[ \t]+/gu, ' ').trim();
const ourRuns = () => distributions().filter((name) => name.startsWith('albera-run-'));

const created = new Set(); // what this run made: the only names the cleanup may unregister
const results = [];
function record(gate, pass, detail = '') {
  results.push({ gate, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${gate}: ${String(detail).trim().replace(/\s*\n\s*/gu, ' | ').slice(0, 400)}`);
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---- a bridge process (as in the bridge gates) ----------------------------------------------------------------------------------------------------------------------------------------
function startBridge(exe, configFile) {
  const child = spawn(exe, ['--trust-sid', currentUserSid(), 'serve', configFile, '--stop-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  let buffered = '';
  child.stdout.on('data', (chunk) => { buffered += chunk; const parts = buffered.split(/\r?\n/u); buffered = parts.pop(); lines.push(...parts); if (process.env.GATE_DEBUG) for (const part of parts) console.log(`BRIDGE ${part}`); });
  child.stderr.on('data', () => {});
  const ready = new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (lines.includes('BRIDGE_READY')) { clearInterval(timer); resolve(); } else if (child.exitCode !== null) { clearInterval(timer); reject(new Error(`bridge exited ${child.exitCode}: ${lines.join(' | ')}`)); } }, 100);
  });
  const stop = async () => { if (child.exitCode === null) { child.stdin.end(); await new Promise((resolve) => { child.on('close', resolve); setTimeout(resolve, 60_000); }); } return child.exitCode; };
  return { child, lines, ready, stop };
}

// ---- the stand-in for Claude Code: an MCP client of the real shell server over stdio ------------------------------------------------------------------------------------------------------
function startMcp(command, args) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 1;
  let buffered = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    const parts = buffered.split('\n');
    buffered = parts.pop();
    for (const line of parts.filter((x) => x.trim() !== '')) { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const exited = new Promise((resolve) => { child.once('close', resolve); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.once('close', () => reject(new Error(`shell server exited: ${stderr.trim()}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  const close = async () => { child.stdin.end(); await Promise.race([exited, sleep(5000)]); if (child.exitCode === null) child.kill(); };
  return { request, notify, call, close, stderr: () => stderr };
}
const textOf = (result) => result?.content?.map((part) => part.text).join('\n') ?? '';

let bridge;
let broker;
async function main() {
  const before = overview();
  const namesBefore = distributions();
  console.log(`INFO distributions before: ${before.replace(/\n/gu, ' | ')}`);
  console.log('INFO stand-ins: guard is { check: async () => true }; runDriver is a stdio MCP client of the real albera-shell-mcp-main.mjs, not Claude Code');
  if (namesBefore.some((name) => name.startsWith('albera-'))) throw new Error('an albera-* distribution is already there; it was left alone, look at it first');
  mkdirSync(folder, { recursive: true });
  const stateDir = makeTrustedTempDirectory('albera-jobgate-state-');
  const distDir = makeTrustedTempDirectory('albera-jobgate-dist-');
  const imageDir = makeTrustedTempDirectory('albera-jobgate-image-');
  const floorDir = makeTrustedTempDirectory('albera-jobgate-floor-');
  const brokerDir = makeTrustedTempDirectory('albera-jobgate-broker-');
  const floorFile = path.join(floorDir, 'lease-floor');
  writeFileSync(floorFile, '1\n');
  const imageCopy = path.join(imageDir, 'albera-wsl2.tar');
  copyFileSync(image, imageCopy);
  const imageSha = sha256(readFileSync(imageCopy));

  const repo = path.join(folder, 'repo');
  const git = (...args) => spawnSync(GIT, ['-C', repo, ...args], { encoding: 'utf8' });
  mkdirSync(repo, { recursive: true });
  spawnSync(GIT, ['init', '-q', repo]);
  writeFileSync(path.join(repo, 'hello.txt'), 'hello\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'one');
  const headOnDisk = git('rev-parse', 'HEAD').stdout.trim();

  // 1. the throwaway key: its public half goes to the bridge, its private half to the Broker
  const KEY_ID = 'job-gate-key';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey }).publicKeySpki;
  const keyFile = path.join(brokerDir, 'attestation.pk8');
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'der' }));

  const helper = await buildPipeClient(path.join(folder, 'helper'));
  const helperSha256 = (await captureExecutableIdentity(helper)).sha256;
  const sid = currentUserSid();
  const bridgePipe = `ALBERA_WslBridge_jobgate_${randomBytes(4).toString('hex')}`;
  const COMPUTER = 'pc-wsl';
  const bridgeConfig = {
    pipeName: bridgePipe, controlPlaneSid: sid, computerId: COMPUTER, brokerKeyId: KEY_ID, brokerSpki: spki, leaseFloorPath: floorFile, imagePath: imageCopy, imageSha256: imageSha,
    distributionsFolder: distDir, stateFolder: stateDir, gitPath: GIT, minWslVersion: '2.0.0', minKernelVersion: '5.10.0', floorExpiresAt: Math.floor(Date.now() / 1000) + 7200,
    repositories: [{ repositoryId: 'repo-alpha', path: repo }],
  };
  const bridgeConfigFile = path.join(stateDir, 'config.json');
  writeFileSync(bridgeConfigFile, JSON.stringify(bridgeConfig));
  bridge = startBridge(buildBridge(folder), bridgeConfigFile);
  await bridge.ready;
  const client = createWsl2BridgeClient({ pipeName: bridgePipe, serverSid: sid, helperPath: helper, helperSha256, connectTimeoutMs: 10_000 });

  // 2. the real Broker, test-faults build, with a wsl2 computer
  const authority = createTestAuthority();
  const brokerConfig = {
    pipeName: `ALBERA_JobGateBroker_${randomBytes(4).toString('hex')}`, database: path.join(brokerDir, 'broker.sqlite'), authorityKeys: [authority.keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG,
    computers: [{ computerId: COMPUTER, kind: 'wsl2' }], attestation: { keyName: 'albera-test-key', keyId: KEY_ID },
  };
  const brokerConfigFile = path.join(brokerDir, 'broker.config.json');
  writeFileSync(brokerConfigFile, JSON.stringify(brokerConfig));
  broker = startProcess(buildBrokerWithTestSeams(path.join(folder, 'broker-seams')), standInService('serve-loop', brokerConfigFile), { stdin: true, env: { ALBERA_BROKER_TEST_ATTESTATION_PKCS8: keyFile } });
  await waitForLine(broker, 'BROKER_READY');
  const session = brokerSession({ helper, sid, pipeName: brokerConfig.pipeName, pid: broker.pid, authority });
  record('Start: the real bridge and the real Broker answer', bridge.lines.includes('BRIDGE_READY') && broker.lines.includes('BROKER_READY'), `${bridge.lines.join(' | ')} / ${broker.lines.join(' | ')}`);

  // 3. the base commit, as the owner would approve it: the head the bridge reads
  const { head: baseOid } = await client.status({ repositoryId: 'repo-alpha' });
  record('status: the real bridge client reads the head of the repository', baseOid === headOnDisk, baseOid);

  /** A real claim: fence and signature from the real helper, the claim over the real client; returns the Broker-signed lease from the reply. */
  async function claimLease(name) {
    const target = { task: 'add a file', isolation: 'wsl2', repositoryId: 'repo-alpha', baseOid };
    const prepared = await session.prepare(name, { purpose: 'guest.command', action: 'task.start', args: target, computerId: COMPUTER });
    const action = { action: 'task.start', projectId: 'project-1', computerId: COMPUTER, args: target };
    const reply = await sendBrokerRequest({ pipeName: brokerConfig.pipeName, receipt: prepared.receipt, signature: prepared.signature, action, expect: { ownerSid: sid, pid: broker.pid }, helperPath: helper, timeoutMs: 10_000 });
    return { reply, operationId: JSON.parse(Buffer.from(prepared.receipt, 'base64').toString('utf8')).operationId };
  }
  const authenticate = (signed) => authenticateWsl2RunLease(signed, { clock: () => Math.floor(Date.now() / 1000), verify: (keyId, bytes, signature) => keyId === KEY_ID && cryptoVerify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature) });

  const entryPath = path.resolve(here, '../src/runtime/albera-shell-mcp-main.mjs');
  const wsl2 = { client, guard: { check: async () => true }, quarantine: createGitQuarantine({ git: GIT, root: path.join(folder, 'quarantine') }), shell: { command: process.execPath, entryPath, bridge: { pipeName: bridgePipe, serverSid: sid, helperPath: helper, helperSha256 } }, resultsRoot: path.join(folder, 'results') };
  const notes = [];
  const note = (line) => { notes.push(line); if (process.env.GATE_DEBUG) console.log(`NOTE ${line}`); };
  const runOf = (name) => { const runDir = path.join(folder, `run-${name}`); mkdirSync(runDir); return runDir; };
  const initialize = (mcp) => mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'job-gate', version: '0' } });

  // ---- job 1: the whole path ----
  const one = await claimLease('job1');
  created.add(`albera-run-${one.operationId}`);
  let lease1;
  try { lease1 = authenticate(one.reply.lease); } catch (error) { lease1 = null; record('Broker: the claim answers with a lease', false, error.code ?? error.message); }
  record('Broker: the real claim answers with a Broker-signed lease for this repository and commit', lease1 !== null && lease1.baseOid === baseOid && lease1.computerId === COMPUTER && lease1.operationId === one.operationId, `keys ${Object.keys(one.reply).join(',')}`);

  const evidence = {};
  const driver1 = async ({ mcpServer, maxMs }) => {
    const mcp = startMcp(mcpServer.command, [...mcpServer.args, ...desktopMcpLimitArgs({ maxCalls: 50, expiresAtMs: Date.now() + maxMs })]);
    try {
      evidence.initialize = await initialize(mcp);
      mcp.notify('notifications/initialized');
      evidence.tools = (await mcp.request('tools/list', {})).result.tools.map((tool) => tool.name);
      evidence.write = await mcp.call('write', { path: 'repo/job.txt', content: 'made by the job <b>\n' });
      evidence.commit = await mcp.call('run', { command: 'cd repo && git add -A && git -c user.name=job -c user.email=job@x.invalid -c core.hooksPath=/dev/null commit -q -m "job change" && git rev-parse HEAD' });
      evidence.read = await mcp.call('read', { path: 'repo/job.txt' });
      return { outcome: 'claimed_done', reason: 'done', claim: 'DONE', toolCalls: 4 };
    } finally { await mcp.close(); }
  };
  const run1 = { stopRequested: false };
  const job1 = await runWsl2Job({ wsl2, job: { operationId: one.operationId, computerId: COMPUTER, repositoryId: 'repo-alpha', baseOid, lease: one.reply.lease }, run: run1, runDir: runOf('job1'), runDriver: driver1, note });
  const beginRefused = notes.find((line) => line.includes('wsl2_begin_refused'));
  record('lease: the real bridge authenticated the Broker-signed lease (JSON.stringify through StrictJson and C# Authenticate) and began the run', beginRefused === undefined && job1.result.outcome === 'claimed_done', beginRefused ?? `outcome ${job1.result.outcome}, ${job1.result.reason}`);
  record('MCP: tools/list names run, read, write', JSON.stringify([...(evidence.tools ?? [])].sort()) === '["read","run","write"]', JSON.stringify(evidence.tools));
  const commitText = textOf(evidence.commit);
  const resultOid = commitText.match(/\b[0-9a-f]{40}\b/u)?.[0] ?? null;
  record('MCP: write, run (git add and commit as a job user) and read work against the real run', textOf(evidence.write) === 'OK' && /exit code: 0/u.test(commitText) && resultOid !== null && evidence.read?.isError === false && /made by the job <b>/u.test(textOf(evidence.read)), `${textOf(evidence.write)} | ${commitText.replace(/\n/gu, ' ').slice(0, 120)} | ${textOf(evidence.read).replace(/\n/gu, ' ').slice(0, 100)}`);
  const c = job1.collected;
  record('result: ok, agent_reported, resultOid is the job\'s commit, the diff holds the change', c?.ok === true && c.trust === 'agent_reported' && c.resultOid === resultOid && /\+made by the job <b>/u.test(c.diff ?? ''), c ? `${c.ok} ${c.trust} ${c.resultOid} ${c.code ?? ''} files ${c.fileCount}` : 'no result');
  record('result: nothing is left registered after job 1', ourRuns().length === 0 && !existsSync(path.join(distDir, `albera-run-${one.operationId}`)), `runs: ${ourRuns().join()}`);

  // ---- job 2: a stop in the middle of `sleep 300` ----
  const two = await claimLease('job2');
  created.add(`albera-run-${two.operationId}`);
  const run2 = { stopRequested: false };
  const driver2 = async ({ mcpServer, maxMs }) => {
    const mcp = startMcp(mcpServer.command, [...mcpServer.args, ...desktopMcpLimitArgs({ maxCalls: 50, expiresAtMs: Date.now() + maxMs })]);
    try {
      await initialize(mcp);
      mcp.notify('notifications/initialized');
      const sleeping = mcp.call('run', { command: 'sleep 300', timeout_seconds: 290 }).catch(() => null);
      await sleep(2500);
      run2.stopRequested = true; // what the room does on a person's stop
      await run2.stopBridge?.();
      evidence.slept = await Promise.race([sleeping, sleep(20_000).then(() => 'still running')]);
      return { outcome: 'stopped', reason: 'stopped_by_human', claim: '', toolCalls: 1 };
    } finally { await mcp.close(); }
  };
  const job2 = await runWsl2Job({ wsl2, job: { operationId: two.operationId, computerId: COMPUTER, repositoryId: 'repo-alpha', baseOid, lease: two.reply.lease }, run: run2, runDir: runOf('job2'), runDriver: driver2, note });
  record('stop: during `sleep 300` the distribution goes and nothing is collected', ourRuns().length === 0 && job2.collected === null && job2.result.outcome === 'stopped' && evidence.slept !== 'still running', `runs: ${ourRuns().join()}, collected ${job2.collected}, outcome ${job2.result.outcome}, call ${typeof evidence.slept === 'string' ? evidence.slept : textOf(evidence.slept) || 'ended'}`);
  record('stop: no bundle was kept for it, and the one of job 1 still is', !existsSync(path.join(folder, 'results', `${two.operationId}.bundle`)) && existsSync(path.join(folder, 'results', `${one.operationId}.bundle`)), readdirSync(path.join(folder, 'results')).join());

  // ---- a reused lease ----
  const reused = await client.begin(one.operationId, JSON.stringify(one.reply.lease)).then(() => ({ ok: true }), (error) => ({ ok: false, code: error.code, outcome: error.outcome }));
  record('reuse: the lease of job 1 presented again is refused (lease_used), and no distribution appears', reused.ok === false && reused.code === 'lease_used' && ourRuns().length === 0, `${reused.code ?? 'accepted'} ${reused.outcome ?? ''}, runs: ${ourRuns().join()}`);

  console.log(`INFO bridge stopped with exit ${await bridge.stop()}`);
  bridge = undefined;
  broker.stdin.end();
  console.log(`INFO broker stopped with exit ${await waitForExit(broker)}`);
  broker = undefined;
  const others = (listing) => listing.split('\n').filter((line) => !line.includes('albera-')).join('\n');
  record('Your distributions are untouched (same names and states as before)', others(overview()) === others(before), overview().replace(/\n/gu, ' | '));
  for (const dir of [stateDir, distDir, imageDir, floorDir, brokerDir]) rmSync(dir, { recursive: true, force: true });
}

try { await main(); } catch (error) { record('The gate ran to the end', false, error.stack ?? error); } finally {
  if (bridge) await bridge.stop();
  if (broker) { broker.stdin.end(); await waitForExit(broker); }
  for (const name of distributions().filter((n) => created.has(n))) console.log(`INFO cleanup ${name}: ${wsl('--unregister', name).status}`);
  console.log(`INFO distributions after: ${overview().replace(/\n/gu, ' | ')}`);
  console.log(`INFO leftovers in the folder: ${existsSync(folder) ? readdirSync(folder).join(', ') : 'none'}`);
}
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length} of ${results.length} passed`);
if (failed.length) process.exitCode = 1;
