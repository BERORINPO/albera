// ADR-012 gates for the WSL bridge, on the real machine: the real bridge program (built with the test-only trust-sid seam), the real image, real wsl.exe and a throwaway distribution per run. A measuring tool,
// not part of `npm test`. It uses no token, no network and no key of the Broker: leases are signed with a throwaway key that only this process holds.
// It NEVER runs `wsl --shutdown` and never touches a distribution it did not make: `created` holds the names this run made (its `albera-run-*` runs and its own `albera-decoy`), and only those are unregistered.
// An albera-* distribution that is already there stops the gates before anything is made: it is reported and left alone.
//
// Usage: node scripts/wsl2-bridge-gates.mjs <image .tar> <empty folder>
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { buildBridge, makeLeaseKit } from '../test/helpers/wsl-bridge-harness.mjs';
import { currentUserSid, makeTrustedTempDirectory } from '../test/helpers/windows-broker-harness.mjs';
import { createGitQuarantine } from '../src/runtime/git-quarantine.mjs';
import { collectWsl2Result, headOfBundle } from '../src/runtime/room-service-wsl2-run.mjs';

const [image, folder] = process.argv.slice(2);
if (!image || !folder) { console.error('usage: wsl2-bridge-gates.mjs <image .tar> <folder>'); process.exit(2); }
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

// ---- the pipe client: one request per connection ------------------------------------------------------------------------------------------------------------------------------------
const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const VERB = { begin: 1, exec: 2, put: 3, get: 4, end: 5, stop: 6, bundle: 7, status: 8 };
function call(pipe, verb, id, body = Buffer.alloc(0)) {
  const payload = Buffer.concat([Buffer.from([VERB[verb], id.length]), Buffer.from(id), body]);
  return new Promise((resolve, reject) => {
    const socket = net.connect(`\\\\.\\pipe\\${pipe}`);
    let data = Buffer.alloc(0);
    socket.on('connect', () => socket.write(Buffer.concat([u32(payload.length), payload])));
    socket.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
    let failure = null;
    socket.on('error', (error) => { failure = error; }); // the server disconnects after its reply: the broken pipe that follows is the end of the stream
    socket.on('close', () => {
      if (data.length < 5 || data.length < 4 + data.readUInt32BE(0)) return reject(new Error(`no complete reply (${data.length} bytes${failure ? `, ${failure.code}` : ''})`));
      const reply = data.subarray(4, 4 + data.readUInt32BE(0));
      resolve(reply[0] === 0 ? { ok: true, body: reply.subarray(1) } : { ok: false, word: reply.subarray(1).toString('ascii') });
    });
  });
}
/** A client that connects and closes without a word, and is gone before the server has said anything. */
const connectAndLeave = (pipe) => new Promise((resolve, reject) => {
  const socket = net.connect(`\\\\.\\pipe\\${pipe}`);
  socket.on('connect', () => socket.destroy());
  socket.on('close', resolve);
  socket.on('error', reject);
});
const exec = (pipe, id, command, seconds = 30) => call(pipe, 'exec', id, Buffer.concat([u32(seconds), Buffer.from(command)]));
const text = (reply) => (reply.ok ? reply.body.subarray(5).toString() : `refused:${reply.word}`);
const put = (pipe, id, name, data) => call(pipe, 'put', id, Buffer.concat([u32(Buffer.byteLength(name)), Buffer.from(name), data]));

// ---- the bridge process -------------------------------------------------------------------------------------------------------------------------------------------------------------
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

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function waitUntil(predicate, seconds) { for (let i = 0; i < seconds * 4; i++) { if (predicate()) return true; await sleep(250); } return predicate(); }

let bridge;
async function main() {
  const before = overview();
  const namesBefore = distributions();
  console.log(`INFO distributions before: ${before.replace(/\n/gu, ' | ')}`);
  if (namesBefore.some((name) => name.startsWith('albera-'))) throw new Error('an albera-* distribution is already there; it was left alone, look at it first');
  mkdirSync(folder, { recursive: true });
  const stateDir = makeTrustedTempDirectory('albera-bridge-state-');
  const distDir = makeTrustedTempDirectory('albera-bridge-dist-');
  const imageDir = makeTrustedTempDirectory('albera-bridge-image-');
  const floorDir = makeTrustedTempDirectory('albera-bridge-floor-');
  const floorFile = path.join(floorDir, 'lease-floor');
  writeFileSync(floorFile, '1\n');
  const imageCopy = path.join(imageDir, 'albera-wsl2.tar');
  copyFileSync(image, imageCopy);
  const imageSha = sha256(readFileSync(imageCopy));

  // A repository with faults planted for the host side: a pre-commit hook and a core.fsmonitor that would write a marker if git ever ran them.
  const repo = path.join(folder, 'repo');
  const marker = path.join(folder, 'host-ran-something');
  const git = (...args) => spawnSync(GIT, ['-C', repo, ...args], { encoding: 'utf8' });
  mkdirSync(repo, { recursive: true });
  spawnSync(GIT, ['init', '-q', repo]);
  writeFileSync(path.join(repo, 'hello.txt'), 'hello\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'one');
  const baseOid = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(path.join(folder, 'fsmonitor.cmd'), `@echo off\r\necho x> "${marker}"\r\n`);
  git('config', 'core.fsmonitor', path.join(folder, 'fsmonitor.cmd').replaceAll('\\', '/'));
  writeFileSync(path.join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho x > "${marker.replaceAll('\\', '/')}"\n`);
  git('status'); // the control: plain git does run the planted fsmonitor
  const plantWorks = existsSync(marker);
  rmSync(marker, { force: true });
  record('Control: the planted fsmonitor runs under plain git', plantWorks, plantWorks ? 'marker written' : 'no marker, so the hardening result below proves nothing');

  const kit = makeLeaseKit('broker-gate');
  const pipe = `ALBERA_WslBridge_gate_${randomBytes(4).toString('hex')}`;
  const config = {
    pipeName: pipe, controlPlaneSid: currentUserSid(), computerId: 'pc-wsl', brokerKeyId: kit.keyId, brokerSpki: kit.spki, leaseFloorPath: floorFile, imagePath: imageCopy, imageSha256: imageSha,
    distributionsFolder: distDir, stateFolder: stateDir, gitPath: GIT, minWslVersion: '2.0.0', minKernelVersion: '5.10.0', floorExpiresAt: Math.floor(Date.now() / 1000) + 7200,
    repositories: [{ repositoryId: 'repo-alpha', path: repo }],
  };
  const configFile = path.join(stateDir, 'config.json');
  writeFileSync(configFile, JSON.stringify(config));
  const exe = buildBridge(folder);
  const leaseFor = async (operationId, extra = {}) => Buffer.from(JSON.stringify(await kit.lease({ operationId, computerId: 'pc-wsl', repositoryId: 'repo-alpha', baseOid, issuedAt: Math.floor(Date.now() / 1000) - 1, ...extra })));
  const begin = async (id, extra) => { created.add(`albera-run-${id}`); const started = Date.now(); const reply = await call(pipe, 'begin', id, await leaseFor(id, extra)); return { reply, ms: Date.now() - started }; };

  // Leftovers a killed bridge could have left: one of ours and one that must never be touched.
  created.add('albera-run-orphan1').add('albera-decoy');
  console.log(`INFO import orphan and decoy: ${wsl('--import', 'albera-run-orphan1', path.join(distDir, 'orphan1'), imageCopy, '--version', '2').status}, ${wsl('--import', 'albera-decoy', path.join(folder, 'decoy'), imageCopy, '--version', '2').status}`);
  bridge = startBridge(exe, configFile);
  await bridge.ready;
  record('Start: the bridge answers on its pipe and sweeps only its own leftover', bridge.lines.includes('SWEEP=1') && !distributions().includes('albera-run-orphan1') && distributions().includes('albera-decoy'), bridge.lines.join(' | '));

  // G1 on the real machine
  record('G1 no lease', (await call(pipe, 'begin', 'op-none')).word === 'lease_missing', 'lease_missing');
  const expired = await begin('op-expired', { issuedAt: Math.floor(Date.now() / 1000) - 700, ttlSeconds: 100 });
  record('G1 expired lease', expired.reply.word === 'lease_expired', expired.reply.word);
  const other = await begin('op-other', { computerId: 'pc-other' });
  record('G1 wrong computer', other.reply.word === 'lease_target', other.reply.word);
  const moved = await begin('op-moved', { baseOid: 'b'.repeat(40) });
  record('G1 head is not baseOid', moved.reply.word === 'base_moved', moved.reply.word);
  record('G1 refusals left no distribution, and the host ran no planted hook', ourRuns().length === 0 && !existsSync(marker), `${ourRuns().length} runs, marker ${existsSync(marker)}`);

  // A full run
  const run = await begin('op-run1');
  record('begin: lease, image hash, floor, import, agent, bundle', run.reply.ok, `${run.reply.ok ? 'ok' : run.reply.word} in ${run.ms} ms`);
  record('begin: the distribution is albera-run-op-run1 and nothing else was added', ourRuns().join() === 'albera-run-op-run1' && distributions().length === namesBefore.length + 2, distributions().join(', '));
  record('begin: the bridge ran no planted hook or fsmonitor on the host', !existsSync(marker), `marker ${existsSync(marker)}`);
  const who = await exec(pipe, 'op-run1', 'id -u; cat /work/repo/hello.txt; git -C /work/repo rev-parse HEAD; ls /work | tr "\\n" " "');
  record('exec: the job is uid 1000, holds the bridge-made clone at baseOid', text(who).startsWith('1000\nhello\n' + baseOid) && /input\.bundle/u.test(text(who)) && /repo/u.test(text(who)), text(who));
  const hostile = await exec(pipe, 'op-run1', 'env | grep -ci -E "wslenv|C:|/mnt/c|USERPROFILE"; ls /mnt 2>&1 | head -1');
  record('exec: no WSLENV and no Windows path or variable inside', /^0\n/u.test(text(hostile)), text(hostile));
  const data = randomBytes(1024 * 1024);
  const wrote = await put(pipe, 'op-run1', 'blob', data);
  const read = await call(pipe, 'get', 'op-run1', Buffer.from('blob'));
  record('put and get: 1 MiB through the bridge and the agent, same SHA-256', wrote.ok && read.ok && sha256(read.body) === sha256(data), `${wrote.ok} ${read.ok}`);
  const big = await put(pipe, 'op-run1', 'huge', Buffer.alloc(16 * 1024 * 1024 + 1));
  record('limits: a put of 16 MiB + 1 byte is refused by the bridge (too_large)', big.word === 'too_large', big.word ?? 'ok');
  const frameCap = await put(pipe, 'op-run1', 'huge', Buffer.alloc(17 * 1024 * 1024)).catch((error) => ({ word: `closed:${error.message}` }));
  record('limits: a 17 MiB request is cut off at the frame cap before it is read', frameCap.word === 'bad_frame' || String(frameCap.word).startsWith('closed:'), frameCap.word ?? 'ok');
  const planted = await exec(pipe, 'op-run1', 'cd /work/repo && printf "#!/bin/sh\\nid -u > /work/hook-uid\\n" > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && git -c user.name=j -c user.email=j@e commit -q --allow-empty -m two; cat /work/hook-uid; find /work -uid 0 | wc -l');
  record('planted hook in the sandbox runs only as the job (uid 1000), and no file there belongs to root', text(planted).trim() === '1000\n0', text(planted));
  const status = await call(pipe, 'status', 'status');
  const headStatus = await call(pipe, 'status', 'status', Buffer.from('repo-alpha'));
  const unknownStatus = await call(pipe, 'status', 'status', Buffer.from('repo-nobody'));
  const statusOf = (reply) => (reply.ok ? JSON.parse(reply.body.toString('utf8')) : {});
  record('status: the kernel is above the floor, with no head when no repository is named', statusOf(status).kernelOk === true && !('head' in statusOf(status)), status.ok ? status.body.toString() : status.word);
  record('status: the head of a repository is what the bridge reads, and null for an unknown id', statusOf(headStatus).head === baseOid && statusOf(unknownStatus).head === null, `${statusOf(headStatus).head}`);
  const jobCommit = await exec(pipe, 'op-run1', 'cd /work/repo && echo "from the job <b>" >> hello.txt && git -c user.name=j -c user.email=j@x.invalid -c core.hooksPath=/dev/null commit -q -am job && git rev-parse HEAD');
  const resultOid = text(jobCommit).trim().split('\n').pop();
  const handed = await call(pipe, 'bundle', 'op-run1');
  record('bundle: the job\'s commit comes out as a bundle whose HEAD is that commit', handed.ok && headOfBundle(handed.body) === resultOid, handed.ok ? `${handed.body.length} bytes, ${resultOid}` : handed.word);
  const collected = handed.ok ? await collectWsl2Result({ bundle: handed.body, baseOid, operationId: 'op-run1', quarantine: createGitQuarantine({ git: GIT, root: path.join(folder, 'quarantine') }), runDir: mkdirSync(path.join(folder, 'result-run'), { recursive: true }) ?? path.join(folder, 'result-run'), resultsRoot: path.join(folder, 'results') }) : { ok: false, code: 'no_bundle' };
  record('quarantine: the real bundle is inspected, and the diff is agent_reported text', collected.ok === true && collected.trust === 'agent_reported' && collected.resultOid === resultOid && /\+from the job <b>/u.test(collected.diff ?? ''), collected.code ?? `${collected.files?.length} file`);
  const ended = await call(pipe, 'end', 'op-run1');
  record('end: terminate then unregister, the distribution is gone', ended.ok && ourRuns().length === 0 && !existsSync(path.join(distDir, 'albera-run-op-run1')), `${ended.ok ? 'ok' : ended.word}, runs: ${ourRuns().join()}`);

  // Reuse across a restart of the bridge
  const reusedNow = await begin('op-run1');
  record('G1 reused lease', reusedNow.reply.word === 'lease_used', reusedNow.reply.word);
  console.log(`INFO bridge stopped with exit ${await bridge.stop()}`);
  bridge = startBridge(exe, configFile);
  await bridge.ready;
  const reusedAfter = await begin('op-run1', { ttlSeconds: 500 });
  record('G1 reused lease, after the bridge restarted (a fresh signature of the same operation)', reusedAfter.reply.word === 'lease_used', reusedAfter.reply.word);

  // Call count
  await begin('op-calls', { maxCalls: 3 });
  const counted = [];
  for (let i = 0; i < 4; i++) counted.push((await exec(pipe, 'op-calls', 'true')).ok ? 'ok' : 'refused');
  record('calls: the bridge counts them (3 allowed, the fourth refused)', counted.join() === 'ok,ok,ok,refused', counted.join());
  await call(pipe, 'end', 'op-calls');

  // Cutting a run off: stop in the middle of a command
  await begin('op-stop');
  const sleeping = exec(pipe, 'op-stop', 'sleep 300', 600);
  await sleep(1500);
  const stopped = await call(pipe, 'stop', 'op-stop');
  const cut = await Promise.race([sleeping, sleep(20_000).then(() => null)]);
  record('stop: ends a command in flight; terminate, unregister, nothing outlives it', stopped.ok && cut !== null && cut.ok === false && ourRuns().length === 0, `stop ${stopped.ok}, exec ${cut ? cut.word : 'still running'}, runs: ${ourRuns().join()}`);

  // Clients that leave without a word must not cost the pipe its instances: stop still has to get through, and more of them than there are instances.
  await begin('op-silent');
  for (let i = 0; i < 8; i++) await connectAndLeave(pipe);
  const afterSilent = await call(pipe, 'stop', 'op-silent');
  record('pipe: stop still arrives after 8 clients connected and closed without a word', afterSilent.ok && ourRuns().length === 0, `${afterSilent.ok ? 'ok' : afterSilent.word}, runs: ${ourRuns().join()}`);
  await begin('op-readers');
  for (let i = 0; i < 8; i++) await call(pipe, 'end', 'no-such-run');
  const afterReaders = await call(pipe, 'stop', 'op-readers');
  record('pipe: stop still arrives after 8 clients read their reply and closed', afterReaders.ok && ourRuns().length === 0, `${afterReaders.ok ? 'ok' : afterReaders.word}, runs: ${ourRuns().join()}`);

  // A hostile agent: the bridge's own cap on a file the job made
  await begin('op-huge');
  await exec(pipe, 'op-huge', 'head -c 17500000 /dev/zero > big');
  const huge = await call(pipe, 'get', 'op-huge', Buffer.from('big'));
  record('limits: a file over the get cap ends the run', huge.word === 'agent_limit' && ourRuns().length === 0, `${huge.word}, runs: ${ourRuns().join()}`);

  // The lease's end, with nobody calling
  await begin('op-short', { ttlSeconds: 12 });
  record('lease end: the run is there while the lease is', ourRuns().includes('albera-run-op-short'), ourRuns().join());
  const reaped = await waitUntil(() => ourRuns().length === 0, 40);
  record('lease end: the bridge ends the run itself when expiresAt passes', reaped, `runs: ${ourRuns().join()}`);

  // Revocation, as the runbook does it: the floor file is rewritten and the bridge keeps running.
  await begin('op-old');
  record('revocation: a run of generation 1 is going', ourRuns().includes('albera-run-op-old'), ourRuns().join());
  writeFileSync(floorFile, '2\n');
  const refusedOld = await begin('op-old2');
  record('revocation: rewriting the file, with no restart, refuses the next begin of the old generation', refusedOld.reply.word === 'lease_generation', refusedOld.reply.word ?? 'ok');
  const revoked = await waitUntil(() => !ourRuns().includes('albera-run-op-old'), 20);
  record('revocation: the reaper ends the run below the floor', revoked && bridge.lines.includes('REAP=generation run=op-old'), `runs: ${ourRuns().join()}`);
  const fresh = await begin('op-new', { leaseGeneration: 2 });
  record('revocation: a lease of the new generation is accepted', fresh.reply.ok, fresh.reply.word ?? 'ok');
  await call(pipe, 'end', 'op-new');
  rmSync(floorFile);
  const noFloor = await begin('op-nofloor', { leaseGeneration: 2 });
  record('revocation: without the floor file begin is refused', noFloor.reply.word === 'lease_floor_unreadable', noFloor.reply.word ?? 'ok');
  writeFileSync(floorFile, '2\n');

  // Log hygiene
  const log = bridge.lines.join('\n');
  record('log: fixed words only, no path, repository or output', !/repo-alpha|albera-bridge|hello|[A-Za-z]:\\/u.test(log), log.replace(/\n/gu, ' | ').slice(0, 300));
  record('log: the run id stands next to the fixed word', bridge.lines.includes('REAP=expired run=op-short') && bridge.lines.includes('STOP=ok run=op-stop'), 'REAP=expired run=op-short');
  console.log(`INFO bridge stopped with exit ${await bridge.stop()}`);

  const others = (listing) => listing.split('\n').filter((line) => !line.includes('albera-')).join('\n');
  record('Your distributions are untouched (same names and states as before)', others(overview()) === others(before), overview().replace(/\n/gu, ' | '));
  for (const dir of [stateDir, distDir, imageDir, floorDir]) rmSync(dir, { recursive: true, force: true });
}

try { await main(); } catch (error) { record('The gates ran to the end', false, error.stack ?? error); } finally {
  if (bridge) await bridge.stop();
  for (const name of distributions().filter((n) => created.has(n))) console.log(`INFO cleanup ${name}: ${wsl('--unregister', name).status}`);
  console.log(`INFO distributions after: ${overview().replace(/\n/gu, ' | ')}`);
  console.log(`INFO leftovers in the folder: ${existsSync(folder) ? readdirSync(folder).join(', ') : 'none'}`);
}
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length} of ${results.length} passed`);
if (failed.length) process.exitCode = 1;
