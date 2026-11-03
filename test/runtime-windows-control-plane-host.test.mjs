import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { getUnavailableReason, icaclsOn, makeTrustedTempDirectory, standInService, startProcess, waitForExit, waitForLine } from './helpers/windows-broker-harness.mjs';
import {
  buildControlPlaneHost, copyNode, ENTRY_NOISY, ENTRY_STAYS_ALIVE, ENTRY_WITH_GRANDCHILD, entryExits, entryLivesFor, eventually, isAlive, makeInstallation,
} from './helpers/control-plane-host-harness.mjs';

// Windows-only, same-user, unprivileged. The host's `service` entry needs the SCM, which these tests never touch: no service is registered, started or queried.
// What runs here is (1) the config validation the service performs, through `service-check` and `launch-check`; (2) the `service` entry started outside the SCM,
// which must fail fast and start nothing; (3) the real supervisor (Supervisor.cs) through the test-only `serve` entry of the seam build, where end of stdin plays
// SERVICE_CONTROL_STOP and node is a copy of this machine's node.exe running a fake entry script. The SCM part (RUNNING / STOP / the service identity) is lab-only.
const EXIT_CONFIG_INVALID = 73, EXIT_NOT_BY_SCM = 74, EXIT_RESTART_LIMIT = 77, EXIT_CHILD_REFUSED = 78, EXIT_USAGE = 64;
const EVERYONE_WRITE = '*S-1-1-0:(W)';

describe('Control Plane host: config, launch gate, supervision and stop', { skip: getUnavailableReason() }, () => {
  let root, shipped, seamed, node;
  const running = new Set();
  let counter = 0;
  before(() => {
    root = makeTrustedTempDirectory('albera-cphost-'); // long form, DACL = this user + SYSTEM only
    shipped = buildControlPlaneHost(path.join(root, 'host-shipped'), { seams: false });
    seamed = buildControlPlaneHost(path.join(root, 'host-seams'), { seams: true });
    node = copyNode(root);
  });
  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const nextName = (prefix) => `${prefix}-${++counter}`;
  const install = (prefix, options) => makeInstallation(root, nextName(prefix), node, options);
  function run(exe, args) {
    const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return { code: result.status, lines: result.stdout.split(/\r?\n/u).filter(Boolean), stderr: result.stderr };
  }
  const check = (config) => run(seamed, standInService('service-check', config));
  const launchCheck = (config) => run(seamed, standInService('launch-check', config));
  /** Starts the foreground supervisor; `child.stdin.end()` plays SERVICE_CONTROL_STOP. */
  function serve(config, env) {
    const child = startProcess(seamed, standInService('serve', config), { stdin: true, env });
    running.add(child);
    child.once('close', () => running.delete(child));
    return child;
  }
  const stopAndWait = (child) => { child.stdin.end(); return waitForExit(child); };
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const runCount = (installation) => (existsSync(path.join(installation.data, 'runs.txt')) ? readFileSync(path.join(installation.data, 'runs.txt'), 'utf8').split('\n').filter(Boolean).length : 0);

  describe('config validation (service-check)', () => {
    it('accepts a complete config, a UTF-8 BOM, and other top-level keys the room owns (the host reads only `host`)', () => {
      const plain = install('ok', { entry: ENTRY_STAYS_ALIVE });
      assert.deepEqual(check(plain.config), { code: 0, lines: ['SERVICE_CONFIG=ok'], stderr: '' });
      const bom = install('ok-bom', { entry: ENTRY_STAYS_ALIVE });
      writeFileSync(bom.config, `\uFEFF${JSON.stringify({ host: bom.settings })}`);
      assert.equal(check(bom.config).code, 0, 'PowerShell 5.1 Set-Content -Encoding UTF8 writes a BOM');
      const room = install('ok-room', { entry: ENTRY_STAYS_ALIVE, topLevel: { claude: { model: 'x', nested: { deep: [1, 2, { a: 1 }] } }, credential: 'claude-oauth-token' } });
      assert.equal(check(room.config).code, 0);
      for (const edge of [{ maxRestarts: 0 }, { maxRestarts: 20 }, { logMaxBytes: 8192 }, { logMaxBytes: 67_108_864 }, { restartDelayMs: 100 }, { restartDelayMs: 10_000 }, { stableRunMs: 500 }, { stableRunMs: 3_600_000 }]) {
        assert.equal(check(install('ok-edge', { entry: ENTRY_STAYS_ALIVE, host: edge }).config).code, 0, JSON.stringify(edge));
      }
    });

    /** Values of the `host` block the service must refuse, with the one reason word each must print. */
    const hostCases = () => {
      const folder = install('cases', { entry: ENTRY_STAYS_ALIVE }).settings;
      const wrong = (key, value, reason) => [`${key} = ${JSON.stringify(value)}`, { [key]: value }, reason];
      return [
        wrong('nodePath', 'node.exe', 'node_path'), wrong('nodePath', '..\\node.exe', 'node_path'), wrong('nodePath', 'C:\\Windows\\System32\\cmd.exe', 'node_path'), wrong('nodePath', 'C:/nodejs/node.exe', 'node_path'),
        wrong('nodePath', `\\\\?\\${folder.nodePath}`, 'node_path'), wrong('nodePath', `${folder.nodePath}:stream`, 'node_path'), wrong('nodePath', 5, 'node_path'), wrong('nodePath', null, 'node_path'),
        wrong('nodeSha256', folder.nodeSha256.toUpperCase(), 'node_sha256'), wrong('nodeSha256', folder.nodeSha256.slice(1), 'node_sha256'), wrong('nodeSha256', `${folder.nodeSha256}0`, 'node_sha256'),
        wrong('nodeSha256', `g${folder.nodeSha256.slice(1)}`, 'node_sha256'), wrong('nodeSha256', 0, 'node_sha256'),
        wrong('appPath', 'app', 'app_path'), wrong('appPath', `${folder.appPath}\\`, 'app_path'), wrong('appPath', path.join(root, 'no-such-folder'), 'app_path'), wrong('appPath', folder.nodePath, 'app_path'),
        wrong('dataRoot', path.join(root, 'no-such-folder'), 'data_root'), wrong('dataRoot', 'data', 'data_root'), wrong('dataRoot', true, 'data_root'),
        wrong('logDirectory', path.join(root, 'no-such-folder'), 'log_directory'), wrong('logDirectory', 'logs', 'log_directory'), wrong('logDirectory', ['x'], 'log_directory'),
        wrong('logMaxBytes', 8191, 'log_max_bytes'), wrong('logMaxBytes', 67_108_865, 'log_max_bytes'), wrong('logMaxBytes', 65_536.5, 'log_max_bytes'), wrong('logMaxBytes', '65536', 'log_max_bytes'),
        wrong('maxRestarts', -1, 'max_restarts'), wrong('maxRestarts', 21, 'max_restarts'), wrong('maxRestarts', 1.5, 'max_restarts'), wrong('maxRestarts', null, 'max_restarts'),
        wrong('restartDelayMs', 99, 'restart_delay'), wrong('restartDelayMs', 10_001, 'restart_delay'), wrong('restartDelayMs', '100', 'restart_delay'),
        wrong('stableRunMs', 499, 'stable_run'), wrong('stableRunMs', 3_600_001, 'stable_run'), wrong('stableRunMs', false, 'stable_run'),
        ['an unknown key', { extra: 1 }, 'config_keys'], ['a missing nodePath', { nodePath: undefined }, 'config_keys'], ['a missing stableRunMs', { stableRunMs: undefined }, 'config_keys'],
        ['a misspelt key', { nodePat: 'x', nodePath: undefined }, 'config_keys'],
      ];
    };

    it('refuses every wrong value of the `host` block with one fixed reason and exit 73', () => {
      for (const [label, overrides, reason] of hostCases()) {
        const result = check(install('bad', { entry: ENTRY_STAYS_ALIVE, host: overrides }).config);
        assert.deepEqual([result.code, result.lines], [EXIT_CONFIG_INVALID, [`SERVICE_CONFIG=invalid:${reason}`]], label);
      }
    });

    it('refuses a file that is not a config: syntax, shape, repeated names, size, a relative or missing path', () => {
      const good = install('shape', { entry: ENTRY_STAYS_ALIVE });
      const goodText = JSON.stringify({ host: good.settings });
      const raw = (name, text) => { const file = path.join(root, `${nextName(name)}.json`); writeFileSync(file, text); return file; };
      const reasonOf = (config) => check(config).lines[0];
      assert.equal(reasonOf(raw('syntax', '{ not json')), 'SERVICE_CONFIG=invalid:config_syntax');
      assert.equal(reasonOf(raw('empty', '')), 'SERVICE_CONFIG=invalid:config_syntax');
      for (const text of ['[]', '"host"', '5', 'null', '{}', '{"host":[]}', '{"host":"x"}', '{"Host":{}}']) assert.equal(reasonOf(raw('shape', text)), 'SERVICE_CONFIG=invalid:config_keys', text);
      assert.equal(reasonOf(raw('dup-host', `${goodText.slice(0, -1)},"host":${JSON.stringify(good.settings)}}`)), 'SERVICE_CONFIG=invalid:config_keys', 'a repeated top-level host');
      assert.equal(reasonOf(raw('dup-key', goodText.replace('"maxRestarts":2', '"maxRestarts":2,"maxRestarts":3'))), 'SERVICE_CONFIG=invalid:config_keys', 'a repeated key inside host');
      assert.equal(reasonOf(raw('big', JSON.stringify({ host: good.settings, padding: 'x'.repeat(17 * 1024) }))), 'SERVICE_CONFIG=invalid:config_too_large');
      assert.equal(reasonOf('config.json'), 'SERVICE_CONFIG=invalid:config_path');
      assert.equal(reasonOf(path.join(root, 'missing.json')), 'SERVICE_CONFIG=invalid:config_unreadable');
      assert.equal(check(good.config).code, 0, 'the baseline is still valid');
    });

    it('refuses a config that others can write, or that its owner is not trusted for (config_untrusted)', () => {
      const writable = install('writable', { entry: ENTRY_STAYS_ALIVE });
      icaclsOn(writable.config, '/grant', EVERYONE_WRITE);
      assert.deepEqual(check(writable.config), { code: EXIT_CONFIG_INVALID, lines: ['SERVICE_CONFIG=invalid:config_untrusted'], stderr: '' });
      // The shipped build has no stand-in: a file the signed-in user can write is not one SYSTEM or the administrators alone control.
      const ordinary = install('ordinary', { entry: ENTRY_STAYS_ALIVE });
      assert.deepEqual(run(shipped, ['service-check', ordinary.config]), { code: EXIT_CONFIG_INVALID, lines: ['SERVICE_CONFIG=invalid:config_untrusted'], stderr: '' });
    });
  });

  describe('launch gate (launch-check, and before every start)', () => {
    it('passes for a node whose hash matches and an app tree nobody else can write', () => {
      assert.deepEqual(launchCheck(install('gate-ok', { entry: ENTRY_STAYS_ALIVE }).config), { code: 0, lines: ['SERVICE_CONFIG=ok', 'CPHOST_LAUNCH=ok'], stderr: '' });
    });

    it('refuses a node whose SHA-256 differs, a missing node, a missing entry, and anything writable by others', () => {
      const refused = (installation, word) => assert.deepEqual(launchCheck(installation.config), { code: EXIT_CHILD_REFUSED, lines: ['SERVICE_CONFIG=ok', `CPHOST_LAUNCH=refused:${word}`], stderr: '' }, word);
      refused(install('gate-hash', { entry: ENTRY_STAYS_ALIVE, host: { nodeSha256: '0'.repeat(64) } }), 'node_hash');
      refused(install('gate-missing-node', { entry: ENTRY_STAYS_ALIVE, host: { nodePath: path.join(root, 'no-node', 'node.exe') } }), 'node_missing');
      const noEntry = install('gate-no-entry', { entry: ENTRY_STAYS_ALIVE });
      rmSync(noEntry.entry);
      refused(noEntry, 'entry_missing');
      const writableEntry = install('gate-entry-writable', { entry: ENTRY_STAYS_ALIVE });
      icaclsOn(writableEntry.entry, '/grant', EVERYONE_WRITE);
      refused(writableEntry, 'app_untrusted');
      const writableFolder = install('gate-folder-writable', { entry: ENTRY_STAYS_ALIVE });
      icaclsOn(path.dirname(writableFolder.entry), '/grant', '*S-1-1-0:(OI)(CI)(W)');
      refused(writableFolder, 'app_untrusted');
      // node.exe is shared by the other tests: a separate copy for this case.
      const nodeFolder = path.join(root, nextName('node-writable'));
      mkdirSync(nodeFolder);
      const ownNode = copyNode(nodeFolder);
      icaclsOn(ownNode.path, '/grant', EVERYONE_WRITE);
      refused(makeInstallation(root, nextName('gate-node-writable'), ownNode, { entry: ENTRY_STAYS_ALIVE }), 'node_untrusted');
    });
  });

  describe('outside the SCM and usage', () => {
    it('answers 74 at once from `service` when the SCM did not start it, and starts nothing', () => {
      const installation = install('outside-scm', { entry: ENTRY_STAYS_ALIVE });
      const result = run(shipped, ['service', installation.config]);
      assert.deepEqual(result.lines, ['CPHOST_FATAL=SERVICE_CONTROLLER_UNAVAILABLE', 'SERVICE_DISPATCHER_ERROR=1063']);
      assert.equal(result.code, EXIT_NOT_BY_SCM);
      assert.equal(runCount(installation), 0, 'no child was started');
      assert.deepEqual(readdirSync(installation.logs), [], 'no log file was created');
    });

    it('has no foreground `serve`, no `trust-sid` and no other subcommand in the shipped build', () => {
      const installation = install('shipped-usage', { entry: ENTRY_STAYS_ALIVE });
      assert.equal(run(shipped, ['serve', installation.config]).code, EXIT_USAGE);
      assert.equal(run(shipped, ['--trust-sid', 'S-1-5-18', 'service-check', installation.config]).code, EXIT_USAGE);
      for (const args of [[], ['service'], ['service-check'], ['launch-check', 'a', 'b'], ['nonsense']]) assert.equal(run(shipped, args).code, EXIT_USAGE, args.join(' '));
      assert.equal(runCount(installation), 0);
    });
  });

  describe('supervision (serve, the real supervisor without the SCM)', () => {
    it('starts node with the fixed arguments, the app folder as its directory and an environment built only from the allowlist', async () => {
      const installation = install('env', { entry: ENTRY_STAYS_ALIVE });
      const leaks = {
        ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test', NODE_OPTIONS: '--require=./nope.js', HTTPS_PROXY: 'http://proxy.invalid:3128',
        ALBERA_ANYTHING: 'x', TEMP: 'C:\\evil-temp',
      };
      const host = serve(installation.config, leaks);
      await waitForLine(host, 'CPHOST_READY');
      const run1 = await eventually(() => readJson(path.join(installation.data, 'last-run.json')));
      assert.ok(run1, 'the fake entry ran');
      assert.deepEqual(run1.argv, [installation.entry, 'room-service', '--data-root', installation.data]);
      assert.equal(run1.cwd.toLowerCase(), installation.app.toLowerCase());
      const system = process.env.SystemRoot;
      const expected = {
        systemroot: system, windir: system, userprofile: os.homedir(), home: os.homedir(), appdata: process.env.APPDATA, localappdata: process.env.LOCALAPPDATA,
        temp: path.join(process.env.LOCALAPPDATA, 'Temp'), tmp: path.join(process.env.LOCALAPPDATA, 'Temp'), path: path.join(system, 'System32'),
      };
      const actual = Object.fromEntries(Object.entries(run1.env).map(([key, value]) => [key.toLowerCase(), value]));
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'exactly the allowlisted names; none of the leaks');
      for (const [key, value] of Object.entries(expected)) assert.equal(actual[key].toLowerCase(), value.toLowerCase(), key);
      assert.equal(await stopAndWait(host), 0);
      assert.ok(host.lines.includes('CPHOST_STOPPED'));
      const started = host.lines.find((line) => line.startsWith('CPHOST_CHILD_STARTED='));
      assert.equal(Number(started.split('=')[1]), run1.pid);
      assert.match(readFileSync(path.join(installation.logs, 'host.log'), 'utf8'), /^\d{4}-\d\d-\d\dT[\d:.]+Z CPHOST_CHILD_STARTED=\d+$/mu);
    });

    it('ends node and everything node started on STOP, and only those', async () => {
      const installation = install('stop-tree', { entry: ENTRY_WITH_GRANDCHILD });
      const bystander = spawn(node.path, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      try {
        const host = serve(installation.config);
        await waitForLine(host, 'CPHOST_READY');
        const pids = await eventually(() => readJson(path.join(installation.data, 'pids.json')));
        assert.ok(pids && isAlive(pids.child) && isAlive(pids.grandchild), 'node and its child are running');
        assert.equal(await stopAndWait(host), 0);
        assert.equal(await eventually(() => !isAlive(pids.child) && !isAlive(pids.grandchild), 5000), true, 'both ended with the Job');
        assert.ok(isAlive(bystander.pid), 'a node the host did not start is untouched');
      } finally { bystander.kill(); }
    });

    it('ends node and its children when the host itself is killed (the Job closes with it)', async () => {
      const installation = install('kill-host', { entry: ENTRY_WITH_GRANDCHILD });
      const host = serve(installation.config);
      await waitForLine(host, 'CPHOST_READY');
      const pids = await eventually(() => readJson(path.join(installation.data, 'pids.json')));
      assert.ok(pids && isAlive(pids.child) && isAlive(pids.grandchild));
      host.kill();
      await waitForExit(host);
      assert.equal(await eventually(() => !isAlive(pids.child) && !isAlive(pids.grandchild), 10_000), true, 'KILL_ON_JOB_CLOSE ended both');
    });

    it('restarts an ending child up to maxRestarts times, then gives up with 77', async () => {
      const installation = install('limit', { entry: entryExits(3), host: { maxRestarts: 2 } });
      const host = serve(installation.config);
      assert.equal(await waitForExit(host), EXIT_RESTART_LIMIT);
      assert.equal(runCount(installation), 3, 'the first run and two restarts');
      assert.deepEqual(host.lines.filter((line) => /^CPHOST_(RESTART|FATAL|CHILD_EXITED)=/u.test(line)),
        ['CPHOST_CHILD_EXITED=3', 'CPHOST_RESTART=1/2', 'CPHOST_CHILD_EXITED=3', 'CPHOST_RESTART=2/2', 'CPHOST_CHILD_EXITED=3', 'CPHOST_FATAL=restart_limit']);
      const none = install('limit-zero', { entry: entryExits(1), host: { maxRestarts: 0 } });
      assert.equal(await waitForExit(serve(none.config)), EXIT_RESTART_LIMIT);
      assert.equal(runCount(none), 1, 'maxRestarts 0 means no restart');
    });

    it('does not count a run that lasted at least stableRunMs against the limit', async () => {
      const installation = install('stable', { entry: entryLivesFor(700), host: { maxRestarts: 1, stableRunMs: 500 } });
      const host = serve(installation.config);
      assert.equal(await eventually(() => runCount(installation) >= 4, 20_000), true, 'four runs in a row, with a limit of one restart');
      assert.equal(host.closeCode, undefined, 'the host is still supervising');
      assert.equal(await stopAndWait(host), 0);
    });

    it('does not restart after STOP, even while it waits to restart', async () => {
      const installation = install('stop-delay', { entry: entryExits(1), host: { maxRestarts: 5, restartDelayMs: 10_000 } });
      const host = serve(installation.config);
      await waitForLine(host, 'CPHOST_RESTART=1/5');
      assert.equal(await stopAndWait(host), 0);
      assert.equal(runCount(installation), 1);
    });

    it('refuses to start node when its SHA-256 differs, and never runs the entry (78)', async () => {
      const installation = install('serve-hash', { entry: ENTRY_STAYS_ALIVE, host: { nodeSha256: 'f'.repeat(64) } });
      const host = serve(installation.config);
      assert.equal(await waitForExit(host), EXIT_CHILD_REFUSED);
      assert.ok(host.lines.includes('CPHOST_FATAL=child_untrusted:node_hash'));
      assert.equal(runCount(installation), 0);
    });

    it('keeps the logs under the cap (one file and one backup per stream) and keeps the latest output', async () => {
      const cap = 8192;
      const installation = install('logs', { entry: ENTRY_NOISY, host: { logMaxBytes: cap } });
      const host = serve(installation.config);
      await waitForLine(host, 'CPHOST_READY');
      const out = path.join(installation.logs, 'room-service.out.log'), err = path.join(installation.logs, 'room-service.err.log');
      const finished = await eventually(() => readFileSync(out, 'utf8').includes('END-OF-OUTPUT out') && readFileSync(err, 'utf8').includes('END-OF-OUTPUT err'));
      assert.equal(finished, true, 'the last lines reached the current files');
      assert.equal(await stopAndWait(host), 0);
      for (const file of [out, err, path.join(installation.logs, 'host.log')]) {
        assert.ok(statSync(file).size <= cap, `${path.basename(file)} is within the cap`);
        if (existsSync(`${file}.1`)) assert.ok(statSync(`${file}.1`).size <= cap, `${path.basename(file)}.1 is within the cap`);
      }
      assert.ok(existsSync(`${out}.1`) && existsSync(`${err}.1`), 'about 300 KB per stream rotated many times');
      assert.deepEqual(readdirSync(installation.logs).sort(), ['host.log', 'room-service.err.log', 'room-service.err.log.1', 'room-service.out.log', 'room-service.out.log.1'], 'no file other than the two logs, their backups and host.log');
      const lastOut = readFileSync(out, 'utf8').trimEnd().split('\n').at(-1);
      assert.equal(lastOut, 'END-OF-OUTPUT out');
      assert.match(readFileSync(`${out}.1`, 'utf8'), /out line \d{6} x{80}\n/u, 'the backup holds earlier output');
    });

    it('appends to the logs of an earlier run and rotates when they are already past the cap', async () => {
      const installation = install('logs-existing', { entry: entryExits(1), host: { logMaxBytes: 8192, maxRestarts: 0 } });
      writeFileSync(path.join(installation.logs, 'host.log'), 'z'.repeat(9000));
      assert.equal(await waitForExit(serve(installation.config)), EXIT_RESTART_LIMIT);
      assert.equal(statSync(path.join(installation.logs, 'host.log.1')).size, 9000, 'the oversized file became the backup');
      assert.match(readFileSync(path.join(installation.logs, 'host.log'), 'utf8'), /CPHOST_CHILD_STARTED=\d+/u);
    });
  });
});
