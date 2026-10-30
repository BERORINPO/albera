import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  brokerSession, buildBroker, buildBrokerWithTestSeams, buildPipeClient, createTestAuthority, currentUserSid, getUnavailableReason, inspectClaimCount, makeTrustedTempDirectory,
  standInService, startProcess, waitForExit, waitForLine, GENERATION, LEASE_CONFIG,
} from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged. The Broker's `service` entry needs the SCM, which these tests never touch: no service is registered,
// started or queried. What runs here is (1) the config validation the service performs, through `service-check`; (2) the `service` entry started
// outside the SCM, which must fail fast and create nothing; (3) the real service serve loop (RunServiceLoopAsync) through the test-only
// `serve-loop` entry of the seam build, where end of stdin plays SERVICE_CONTROL_STOP. The SCM part (RUNNING / STOP / PID) is lab-only.
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const REPLAYED = { ...SUCCESS, replayed: true };
const DENIED = { ok: false, code: 'denied' };
const EXIT_PIPE_UNAVAILABLE = 70, EXIT_CONFIG_INVALID = 73, EXIT_CONTROLLER_UNAVAILABLE = 74, EXIT_USAGE = 64;
const ERROR_FAILED_SERVICE_CONTROLLER_CONNECT = 1063;
const STOP_BUDGET_MS = 5000;
const VIRTUAL_SERVICE_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555';

describe('Broker service host: config validation, outside-SCM behaviour and the serve loop', { skip: getUnavailableReason() }, () => {
  let root, brokerExe, loopExe, helper, sid;
  const authority = createTestAuthority(); // at describe time: the table of rejected configs below is built eagerly
  const running = new Set();
  before(async () => {
    // The Broker accepts only a path already in its final form; CI's TEMP is an 8.3 short name (RUNNER~1) that .NET expands, so use the long one.
    // It also refuses a config / journal folder that other accounts can write, and the machine's temp folder may grant them Modify: build a trusted one.
    root = makeTrustedTempDirectory('albera-service-host-'); // long form, DACL = this user + SYSTEM only
    brokerExe = buildBroker(path.join(root, 'broker'));
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
  });
  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const track = (child) => { running.add(child); child.once('close', () => running.delete(child)); return child; };
  const unique = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
  const pipePath = (pipe) => `\\\\.\\pipe\\${pipe}`;
  /** The Control Plane side of one running Broker: fence, sign with the pinned test authority, send. */
  const sessionOf = (config, child) => brokerSession({ helper, sid, pipeName: config.pipeName, pid: child.pid, authority });

  /** A valid config object; `overrides` replace values, `undefined` removes a key. */
  function validConfig(name, overrides = {}) {
    return { pipeName: unique('ALBERA_SvcHost'), database: path.join(root, `${name}.sqlite`), authorityKeys: [authority.keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG, ...overrides };
  }
  function writeRaw(name, text) {
    const file = path.join(root, `${name}.config.json`);
    writeFileSync(file, text);
    return file;
  }
  const writeConfig = (name, overrides) => writeRaw(name, JSON.stringify(validConfig(name, overrides)));
  function run(exe, args) {
    const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    return { code: result.status, lines: result.stdout.split(/\r?\n/u).filter(Boolean), stderr: result.stderr };
  }
  // The shipped rule trusts the service's own per-service SID, which a host test cannot have in its token, so the validation tests run the test-faults build told to stand in
  // the signed-in user for it (`--trust-sid`). The same file under the shipped rule is refused (see 'the shipped build ...' in the hardening test).
  const check = (file) => run(loopExe, standInService('service-check', file));
  /** 'ENOENT' when no pipe has that name, 'connected' when one does. */
  const connectResult = (pipe) => new Promise((resolve) => {
    const socket = net.createConnection(pipePath(pipe));
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', (error) => resolve(error.code));
  });

  /** Values of `authorityKeys` the service must refuse. */
  function authorityKeyCases() {
    const good = authority.keyEntry;
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const other = createTestAuthority({ kid: 'test-authority-2' }).keyEntry;
    return [
      ['an empty list', []], ['three keys', [good, other, createTestAuthority({ kid: 'test-authority-3' }).keyEntry]], ['not a list (an object)', good], ['not a list (a string)', 'kid=spki'],
      ['an entry that is not an object', ['x']], ['an entry with an extra key', [{ ...good, extra: 1 }]], ['an entry without spki', [{ kid: good.kid }]], ['an entry without kid', [{ spki: good.spki }]],
      ['a kid that is not an id', [{ kid: 'has space', spki: good.spki }]], ['an empty kid', [{ kid: '', spki: good.spki }]], ['a kid of 65 characters', [{ kid: 'k'.repeat(65), spki: good.spki }]],
      ['a repeated kid', [good, { kid: good.kid, spki: other.spki }]], ['the same key under two kids', [good, { kid: 'test-authority-2', spki: good.spki }]],
      ['an spki that is not base64', [{ kid: good.kid, spki: '###' }]], ['an empty spki', [{ kid: good.kid, spki: '' }]], ['an spki of garbage', [{ kid: good.kid, spki: 'AAAA' }]],
      ['a truncated SubjectPublicKeyInfo', [{ kid: good.kid, spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' }]], ['an ECDSA P-384 key (the signature scheme is P-256)', [{ kid: good.kid, spki: p384 }]],
      ['a spki followed by extra bytes', [{ kid: good.kid, spki: Buffer.concat([Buffer.from(good.spki, 'base64'), Buffer.from([0])]).toString('base64') }]],
    ];
  }

  describe('config validation (service-check)', () => {
    it('accepts a complete config with a user SID, a virtual service-account SID, a UTF-8 BOM, or two pinned authority keys', () => {
      assert.deepEqual(check(writeConfig('ok-user')), { code: 0, lines: ['SERVICE_CONFIG=ok'], stderr: '' });
      assert.equal(check(writeConfig('ok-service', { controlPlaneSid: VIRTUAL_SERVICE_SID })).code, 0);
      assert.equal(check(writeRaw('ok-bom', `\uFEFF${JSON.stringify(validConfig('ok-bom'))}`)).code, 0, 'PowerShell 5.1 Set-Content -Encoding UTF8 writes a BOM');
      assert.equal(check(writeConfig('ok-first-generation', { generation: 1 })).code, 0);
      assert.equal(check(writeConfig('ok-two-keys', { authorityKeys: [authority.keyEntry, createTestAuthority({ kid: 'test-authority-2' }).keyEntry] })).code, 0, 'rotation overlap');
    });

    // [label, config overrides, expected reason word]
    const rejected = [
      ...['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-544', 'WD', 'AU', 'BU', 'BA', 's-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555', ' S-1-1-0', ''].map((value) => [`control plane SID ${JSON.stringify(value)}`, { controlPlaneSid: value }, 'control_plane_sid']),
      ...['', '.', '..', '-lead', 'a b', 'a\\b', 'a/b', String.raw`\\.\pipe\x`, 'x'.repeat(129), 'pipe\u0000'].map((value) => [`pipe name ${JSON.stringify(value)}`, { pipeName: value }, 'pipe_name']),
      ...[
        ['relative', 'journal.sqlite'], ['drive-relative', 'C:journal.sqlite'], ['empty', ''], ['UNC', String.raw`\\server\share\journal.sqlite`],
        ['device prefix', String.raw`\\?\C:\journal.sqlite`], ['dot-dot segment', String.raw`C:\temp\..\journal.sqlite`], ['dot segment', String.raw`C:\temp\.\journal.sqlite`],
        ['forward slashes', 'C:/temp/journal.sqlite'], ['doubled separator', String.raw`C:\temp\\journal.sqlite`], ['trailing separator', 'C:\\temp\\journal\\'],
        ['alternate data stream', String.raw`C:\temp\journal.sqlite:stream`], ['wildcard', String.raw`C:\temp\journal*.sqlite`], ['trailing dot', String.raw`C:\temp\journal.`],
        ['too long', `C:\\${'a'.repeat(250)}`],
      ].map(([label, value]) => [`database ${label}`, { database: value }, 'database']),
      ['database in a missing directory', { database: path.join(realpathSync.native(os.tmpdir()), 'albera-no-such-directory', 'journal.sqlite') }, 'database_directory'],
      ...authorityKeyCases().map(([label, value]) => [`authority keys: ${label}`, { authorityKeys: value }, 'authority_keys']),
      ['the v1 shape: a single publicKey instead of authorityKeys', { publicKey: authority.spki, authorityKeys: undefined }, 'config_keys'],
      ['both shapes at once', { publicKey: authority.spki }, 'config_keys'],
      ...[['a string', '7'], ['zero (a lease generation starts at 1)', 0], ['a fraction', 1.5], ['negative', -1], ['null', null], ['beyond int64', 1e19], ['an object', {}]].map(([label, value]) => [`generation ${label}`, { generation: value }, 'generation']),
      ['pipe name of the wrong type', { pipeName: 7 }, 'config_keys'],
      ['unknown key', { hold: true }, 'config_keys'],
      ['missing key', { generation: undefined }, 'config_keys'],
      ['missing SID', { controlPlaneSid: undefined }, 'config_keys'],
      ['missing leaseId (no placeholder default in production)', { leaseId: undefined }, 'config_keys'],
      ['missing policyVersion (no placeholder default in production)', { policyVersion: undefined }, 'config_keys'],
      ...['', ' ', 'has space', '-lead', '.lead', 'a/b', 'a\\b', 'x'.repeat(65), 'lease\u0000', 'lease\n', 5, null, true, ['lease-a'], { id: 'lease-a' }]
        .map((value) => [`leaseId ${JSON.stringify(value)}`, { leaseId: value }, 'lease_id']),
      ...['', ' ', 'has space', '-lead', 'a/b', 'x'.repeat(65), 'policy\n', 5, null, ['policy-a']]
        .map((value) => [`policyVersion ${JSON.stringify(value)}`, { policyVersion: value }, 'policy_version']),
    ];
    for (const [label, overrides, reason] of rejected) {
      it(`rejects ${label} with ${reason}`, () => {
        assert.deepEqual(check(writeRaw('reject', JSON.stringify(validConfig('reject', overrides)))), { code: EXIT_CONFIG_INVALID, lines: [`SERVICE_CONFIG=invalid:${reason}`], stderr: '' });
      });
    }

    it('rejects a repeated key, a non-object document, bad syntax, deep nesting, an oversize file, a missing file and a directory', () => {
      const base = JSON.stringify(validConfig('dup'));
      const cases = [
        ['repeated key', base.replace(/\}$/u, ',"generation":8}'), 'config_keys'],
        ['array document', '[]', 'config_keys'], ['null document', 'null', 'config_keys'], ['empty file', '', 'config_syntax'],
        ['bad syntax', '{"pipeName":', 'config_syntax'], ['comment', `/*x*/${base}`, 'config_syntax'], ['trailing comma', base.replace(/\}$/u, ',}'), 'config_syntax'],
        ['nested value', base.replace(/\}$/u, ',"x":{"y":{"z":{"w":1}}}}'), 'config_syntax'],
        ['oversize file', `${base.slice(0, -1)},"x":"${'a'.repeat(5000)}"}`, 'config_too_large'],
      ];
      for (const [label, text, reason] of cases) {
        assert.deepEqual(check(writeRaw('doc', text)).lines, [`SERVICE_CONFIG=invalid:${reason}`], label);
      }
      assert.deepEqual(check(path.join(root, 'absent.json')).lines, ['SERVICE_CONFIG=invalid:config_unreadable']);
      assert.deepEqual(check(root).lines, ['SERVICE_CONFIG=invalid:config_unreadable'], 'a directory is a plain path but not a readable file');
    });

    it('rejects a relative or odd config path itself', () => {
      for (const odd of ['config.json', String.raw`..\config.json`, String.raw`\\server\share\c.json`, 'C:/temp/c.json']) {
        assert.deepEqual(check(odd).lines, ['SERVICE_CONFIG=invalid:config_path'], odd);
      }
      assert.equal(run(brokerExe, ['service-check']).code, EXIT_USAGE);
      assert.equal(run(brokerExe, ['service-check', 'a', 'b']).code, EXIT_USAGE);
    });

    it('never echoes config content: the output is one fixed line whatever the file says', () => {
      const secret = 'SECRET VALUE 4711';
      const out = check(writeConfig('echo', { pipeName: secret, database: `C:\\${secret}\\j.sqlite`, authorityKeys: secret }));
      assert.deepEqual(out.lines, ['SERVICE_CONFIG=invalid:pipe_name']);
      assert.equal(`${out.lines}${out.stderr}`.includes(secret), false);
    });
  });

  describe('the service entry outside the SCM', () => {
    const journalFiles = (db) => [db, `${db}-wal`, `${db}-shm`].filter((file) => existsSync(file));

    it(`fails fast with exit ${EXIT_CONTROLLER_UNAVAILABLE} (win32 ${ERROR_FAILED_SERVICE_CONTROLLER_CONNECT}), creates no pipe and no journal`, async () => {
      const config = validConfig('outside');
      const started = Date.now();
      const out = run(brokerExe, ['service', writeRaw('outside', JSON.stringify(config))]);
      assert.equal(out.code, EXIT_CONTROLLER_UNAVAILABLE);
      assert.deepEqual(out.lines, ['BROKER_FATAL=SERVICE_CONTROLLER_UNAVAILABLE', `SERVICE_DISPATCHER_ERROR=${ERROR_FAILED_SERVICE_CONTROLLER_CONNECT}`]);
      assert.ok(Date.now() - started < 15_000, 'it must not wait for a service controller');
      assert.equal(await connectResult(config.pipeName), 'ENOENT', 'no pipe was created');
      assert.deepEqual(journalFiles(config.database), []);
    });

    it('does not read the config before the dispatcher: a missing or invalid config still ends in 74, not 73', () => {
      assert.equal(run(brokerExe, ['service', path.join(root, 'absent.json')]).code, EXIT_CONTROLLER_UNAVAILABLE);
      assert.equal(run(brokerExe, ['service', writeRaw('garbage', '{')]).code, EXIT_CONTROLLER_UNAVAILABLE);
    });

    it('answers 64 for the wrong number of arguments and for the seam entries that the shipped build does not have', () => {
      assert.equal(run(brokerExe, ['service']).code, EXIT_USAGE);
      assert.equal(run(brokerExe, ['service', 'a', 'b']).code, EXIT_USAGE);
      const out = run(brokerExe, ['serve-loop', writeConfig('prod-seam')]);
      assert.deepEqual([out.code, out.lines], [EXIT_USAGE, []]);
      assert.equal(run(brokerExe, standInService('service-check', writeConfig('prod-trust-sid'))).code, EXIT_USAGE, '--trust-sid (the test stand-in for the service SID) is not in the shipped build either');
    });
  });

  describe('the service serve loop (seam build, stdin EOF = SERVICE_CONTROL_STOP)', () => {
    function startLoop(name, overrides) {
      const config = validConfig(name, overrides);
      const child = track(startProcess(loopExe, standInService('serve-loop', writeRaw(name, JSON.stringify(config))), { stdin: true }));
      return { child, config };
    }
    /** Ends stdin (the STOP request) and returns how long the process took to exit. */
    async function stop(child) {
      const asked = Date.now();
      child.stdin.end();
      const code = await waitForExit(child);
      return { code, ms: Date.now() - asked };
    }
    /** A raw client that writes `bytes` (if any) and resolves with the framed JSON answer, or `undefined` when the server closed without one.
     *  The one pipe instance is busy (EBUSY) between a Disconnect and the next wait for a client, so a connect that races that moment is retried.
     *  A Disconnect() ends the client's read with EPIPE (a close would be EOF): after a complete answer that is the end of the conversation. */
    async function rawRequest(pipe, bytes) {
      for (let attempt = 0; ; attempt += 1) {
        try { return await rawRequestOnce(pipe, bytes); }
        catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code) || attempt >= 40) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
    }
    const rawRequestOnce = (pipe, bytes) => new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath(pipe));
      const chunks = [];
      socket.once('connect', () => { if (bytes) socket.write(bytes); else socket.destroy(); });
      socket.on('data', (x) => chunks.push(x));
      socket.once('error', (error) => { if (!(error.code === 'EPIPE' && chunks.length > 0)) reject(error); });
      socket.once('close', () => {
        const data = Buffer.concat(chunks);
        resolve(data.length >= 4 ? JSON.parse(data.subarray(4).toString('utf8')) : undefined);
      });
    });

    it('serves consecutive requests from one running process (same PID), then stops cleanly on STOP', async () => {
      const { child, config } = startLoop('loop-two');
      await waitForLine(child, 'BROKER_READY');
      const session = sessionOf(config, child);
      const first = await session.claim('loop-first');
      assert.deepEqual(first.result, SUCCESS);
      assert.deepEqual((await session.claim('loop-second')).result, SUCCESS, 'the pipe was created again and the server PID is unchanged');
      assert.deepEqual(await session.send(first.request), REPLAYED, 'the journal survives between requests: an exact replay gets the recorded outcome');
      assert.equal(child.closeCode, undefined, 'the process kept running after every request');
      assert.equal(child.lines.filter((line) => line === 'BROKER_READY').length, 1, 'READY is announced once, after the first pipe exists');
      const stopped = await stop(child);
      assert.equal(stopped.code, 0);
      assert.ok(stopped.ms < STOP_BUDGET_MS, `stopped in ${stopped.ms} ms`);
      assert.ok(child.lines.includes('BROKER_STOPPED'));
      assert.equal(inspectClaimCount(brokerExe, config.database), 2);
      assert.equal(await connectResult(config.pipeName), 'ENOENT', 'the pipe is gone');
    });

    it('stops promptly while idle in WaitForConnection and while a connected client stalls without sending', async () => {
      const idle = startLoop('loop-idle');
      await waitForLine(idle.child, 'BROKER_READY');
      const idleStop = await stop(idle.child);
      assert.deepEqual([idleStop.code, idleStop.ms < STOP_BUDGET_MS], [0, true], `idle stop took ${idleStop.ms} ms`);

      const stalled = startLoop('loop-stalled');
      await waitForLine(stalled.child, 'BROKER_READY');
      const client = net.createConnection(pipePath(stalled.config.pipeName));
      await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
      client.on('error', () => {});
      await new Promise((resolve) => setTimeout(resolve, 300)); // the loop is now inside the frame read
      const stalledStop = await stop(stalled.child);
      client.destroy();
      assert.deepEqual([stalledStop.code, stalledStop.ms < STOP_BUDGET_MS], [0, true], `stalled-client stop took ${stalledStop.ms} ms`);
      assert.equal(inspectClaimCount(brokerExe, stalled.config.database), 0);
    });

    it('survives a malformed request and a client that connects and leaves, and keeps one claim per valid receipt', async () => {
      const { child, config } = startLoop('loop-hostile');
      await waitForLine(child, 'BROKER_READY');
      const garbage = Buffer.concat([Buffer.from([5, 0, 0, 0]), Buffer.from('xxxxx')]);
      assert.deepEqual(await rawRequest(config.pipeName, garbage), DENIED);
      const oversize = Buffer.alloc(4); oversize.writeInt32LE(1 << 20);
      assert.deepEqual(await rawRequest(config.pipeName, oversize), DENIED, 'a frame length above 2 KiB is refused');
      assert.equal(await rawRequest(config.pipeName, undefined), undefined, 'connect and leave: no answer');
      assert.deepEqual((await sessionOf(config, child).claim('loop-after-hostile')).result, SUCCESS);
      assert.equal(child.closeCode, undefined);
      assert.equal((await stop(child)).code, 0);
      assert.equal(inspectClaimCount(brokerExe, config.database), 1);
    });

    it(`exits ${EXIT_PIPE_UNAVAILABLE} before READY when the pipe name is already taken, and never touches the journal`, async () => {
      const pipe = unique('ALBERA_SvcSquat');
      const state = { connections: 0 };
      const squatter = net.createServer((socket) => { state.connections += 1; socket.destroy(); });
      await new Promise((resolve, reject) => { squatter.once('error', reject); squatter.listen(pipePath(pipe), resolve); });
      try {
        const { child, config } = startLoop('loop-squat', { pipeName: pipe });
        assert.equal(await waitForExit(child), EXIT_PIPE_UNAVAILABLE, child.lines.join('|'));
        assert.deepEqual(child.lines, ['BROKER_FATAL=PIPE_UNAVAILABLE', 'BROKER_STOPPED']);
        assert.equal(state.connections, 0);
        assert.equal(existsSync(config.database), false);
      } finally { await new Promise((resolve) => squatter.close(resolve)); }
    });

    it('does not start on an invalid config: exit 73, no pipe, no journal', async () => {
      const config = validConfig('loop-bad', { controlPlaneSid: 'S-1-1-0' });
      const child = track(startProcess(loopExe, standInService('serve-loop', writeRaw('loop-bad', JSON.stringify(config))), { stdin: true }));
      assert.equal(await waitForExit(child), EXIT_CONFIG_INVALID);
      assert.deepEqual(child.lines, []);
      assert.equal(existsSync(config.database), false);
    });
  });
});
