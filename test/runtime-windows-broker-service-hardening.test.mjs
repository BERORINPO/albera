import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  brokerSession, buildBroker, buildBrokerWithTestSeams, buildPipeClient, createTestAuthority, currentUserSid, getUnavailableReason, icaclsOn, inspectClaimCount,
  makeTrustedTempDirectory, startProcess, waitForExit, waitForLine, GENERATION,
} from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged. Hardening of the Broker service host after the CISO review (decision-log row 2026-10-30+broker-service-hardening):
//  1. the config file and the database folder / journal files must be owned and writable only by trusted principals and free of reparse points;
//  2. the serve loop keeps ONE pipe instance (Disconnect + wait again), so the name is never free between two requests;
//  3. the Control Plane SID is a real virtual service account or a user, not ALL SERVICES / a group;
//  4. the answer to a committed claim is written even when STOP arrives while the claim is running;
//  5. a signed receipt with a wrongly typed number is denied instead of stopping the service;
//  6. (ADR-002 accept condition C3, decision-log row 2026-10-30+adr002-broker-accept-conditions) the running service holds its database folder open
//     without FILE_SHARE_DELETE, so the folder cannot be renamed, deleted or swapped between requests.
// Nothing here registers or starts a service, and no ACL outside folders this file creates is touched (icacls on its own temp folders only).
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const DENIED = { ok: false, code: 'denied' };
const EXIT_CONFIG_INVALID = 73;
const STOP_BUDGET_MS = 5000;
const USERS = '*S-1-5-32-545', EVERYONE = '*S-1-1-0', AUTHENTICATED_USERS = '*S-1-5-11';
const TRUSTED_INSTALLER = '*S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const VIRTUAL_SERVICE_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555';

describe('Broker service host hardening', { skip: getUnavailableReason() }, () => {
  let root, brokerExe, loopExe, helper, sid;
  const authority = createTestAuthority();
  const running = new Set();
  before(async () => {
    root = makeTrustedTempDirectory('albera-service-hardening-'); // long form, DACL = this user + SYSTEM only (the trusted baseline)
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
  /** fence -> sign with the pinned test authority -> send, through the real pipe client helper (it retries the pre-send `broker_unavailable` of the moment between two requests). */
  const claim = async (config, child, name, overrides) =>
    (await brokerSession({ helper, sid, pipeName: config.pipeName, pid: child.pid, authority }).claim(name, overrides)).result;
  const run = (exe, args) => {
    const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    return { code: result.status, lines: result.stdout.split(/\r?\n/u).filter(Boolean), stderr: result.stderr };
  };

  /** A new folder under the trusted root (it inherits the trusted ACL; the name gets a counter so every call is fresh). Returns { dir, databaseDir, configFile, database }; the config file is written. */
  let scenarios = 0;
  function scenario(name, overrides = {}) {
    const dir = path.join(root, `${name}-${(scenarios += 1)}`);
    mkdirSync(dir);
    const databaseDir = path.join(dir, 'db'); // the config stays outside it, so a grant on the database folder does not reach the config file
    mkdirSync(databaseDir);
    const database = path.join(databaseDir, 'journal.sqlite');
    const config = path.join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ pipeName: unique('ALBERA_Harden'), database, authorityKeys: [authority.keyEntry], controlPlaneSid: sid, generation: GENERATION, ...overrides }));
    return { dir, databaseDir, configFile: config, database };
  }
  const check = (file) => run(brokerExe, ['service-check', file]);
  const invalid = (reason) => ({ code: EXIT_CONFIG_INVALID, lines: [`SERVICE_CONFIG=invalid:${reason}`], stderr: '' });

  describe('finding 1: config file and database folder must be trusted (service-check)', () => {
    it('accepts a folder and a config that only this user, SYSTEM and read-only principals can reach, with or without existing journal files', () => {
      assert.deepEqual(check(scenario('clean').configFile), { code: 0, lines: ['SERVICE_CONFIG=ok'], stderr: '' });
      const readers = scenario('readers');
      icaclsOn(readers.databaseDir, '/grant', `${USERS}:(OI)(CI)RX`, `${AUTHENTICATED_USERS}:(OI)(CI)R`);
      assert.equal(check(readers.configFile).code, 0, 'read access for other accounts is not a write right');
      const existing = scenario('existing-journal');
      for (const suffix of ['', '-wal', '-shm', '-journal']) writeFileSync(`${existing.database}${suffix}`, '');
      assert.equal(check(existing.configFile).code, 0, 'journal files that are owned and writable by this user only are fine');
    });

    // [label, icacls grant]. Every one of these lets someone who is not the service (or SYSTEM / Administrators) change what the folder holds.
    const folderGrants = [
      ['Users modify, inherited', `${USERS}:(OI)(CI)M`], ['Users write, this folder only', `${USERS}:W`], ['Everyone add file', `${EVERYONE}:(WD)`],
      ['Authenticated Users add subdirectory', `${AUTHENTICATED_USERS}:(AD)`], ['Users delete child', `${USERS}:(DC)`], ['Users delete', `${USERS}:(D)`],
      ['Users change permissions', `${USERS}:(WDAC)`], ['Users take ownership', `${USERS}:(WO)`],
      ['Users add file, inherit-only (decides who may write the next file created here)', `${USERS}:(OI)(CI)(IO)(WD)`],
      ['an unrelated service account (TrustedInstaller) write', `${TRUSTED_INSTALLER}:(OI)(CI)W`],
    ];
    for (const [label, grant] of folderGrants) {
      it(`refuses a database folder with: ${label} (database_untrusted)`, () => {
        const s = scenario('folder-acl');
        icaclsOn(s.databaseDir, '/grant', grant);
        assert.deepEqual(check(s.configFile), invalid('database_untrusted'));
        assert.equal(existsSync(s.database), false, 'the check creates nothing');
      });
    }

    const fileGrants = [
      ['Users write data', `${USERS}:(WD)`], ['Users append', `${USERS}:(AD)`], ['Users delete', `${USERS}:(D)`], ['Users change permissions', `${USERS}:(WDAC)`],
      ['Users take ownership', `${USERS}:(WO)`], ['Everyone modify', `${EVERYONE}:(M)`],
    ];
    for (const [label, grant] of fileGrants) {
      it(`refuses a config file with: ${label} (config_untrusted)`, () => {
        const s = scenario('config-acl');
        icaclsOn(s.configFile, '/grant', grant);
        assert.deepEqual(check(s.configFile), invalid('config_untrusted'));
      });
    }

    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      it(`refuses an existing journal file${suffix ? ` ${suffix}` : ''} that another account can write, even in a clean folder (database_untrusted)`, () => {
        const s = scenario('journal-acl');
        writeFileSync(`${s.database}${suffix}`, '');
        icaclsOn(`${s.database}${suffix}`, '/grant', `${USERS}:(WD)`);
        assert.deepEqual(check(s.configFile), invalid('database_untrusted'));
      });
    }

    it('refuses a config or database folder reached through a junction, or below one (config_untrusted / database_untrusted)', () => {
      const real = scenario('junction-real');
      const parentLink = path.join(root, `junction-parent-${scenarios}`), folderLink = path.join(root, `junction-folder-${scenarios}`);
      symlinkSync(real.dir, parentLink, 'junction');
      symlinkSync(real.databaseDir, folderLink, 'junction');
      assert.equal(check(real.configFile).code, 0, 'control: the same files without a junction are accepted');
      assert.deepEqual(check(path.join(parentLink, 'config.json')), invalid('config_untrusted'), 'config below a junction');
      const viaFolder = scenario('junction-folder', { database: path.join(folderLink, 'journal.sqlite') });
      assert.deepEqual(check(viaFolder.configFile), invalid('database_untrusted'), 'the database folder is the junction');
      const viaParent = scenario('junction-parent', { database: path.join(parentLink, 'db', 'journal.sqlite') });
      assert.deepEqual(check(viaParent.configFile), invalid('database_untrusted'), 'a parent of the database folder is the junction');
    });

    it('refuses a config file owned by someone else with a writer outside the trusted set (a system file stands in; the owner rule alone is not testable without privilege)', (t) => {
      const system = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'notepad.exe'); // owned by TrustedInstaller
      if (!existsSync(system)) return t.skip('no TrustedInstaller-owned file to point at');
      assert.deepEqual(check(system), invalid('config_untrusted'));
    });

    it('a service whose database folder is untrusted does not start: exit 73, no pipe, no journal', async () => {
      const s = scenario('loop-untrusted');
      icaclsOn(s.databaseDir, '/grant', `${USERS}:(OI)(CI)M`);
      const child = track(startProcess(loopExe, ['serve-loop', s.configFile], { stdin: true }));
      assert.equal(await waitForExit(child), EXIT_CONFIG_INVALID);
      assert.deepEqual(child.lines, []);
      assert.equal(existsSync(s.database), false);
    });
  });

  describe('finding 3: the Control Plane SID is a virtual service account or a user, never ALL SERVICES or a group (service-check)', () => {
    const domain = () => sid.slice(0, sid.lastIndexOf('-'));
    /** SIDs of S-1-5-21 groups this process token belongs to (local aliases such as docker-users), other than the user itself. */
    const tokenGroupSids = () => execFileSync(path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/u).flatMap((line) => line.match(/S-1-5-21-[0-9-]+/u) ?? []).filter((x) => x !== sid);
    const checkSid = (value) => check(scenario('sid', { controlPlaneSid: value }).configFile);

    it('accepts the signed-in user and a virtual service account with exactly five sub-authorities after 80', () => {
      assert.equal(checkSid(sid).code, 0);
      assert.equal(checkSid(VIRTUAL_SERVICE_SID).code, 0);
    });

    for (const [label, value] of [
      ['ALL SERVICES', 'S-1-5-80-0'], ['S-1-5-80 alone', 'S-1-5-80'], ['four sub-authorities after 80', 'S-1-5-80-1-2-3-4'],
      ['six sub-authorities after 80', 'S-1-5-80-1-2-3-4-5-6'], ['four zero sub-authorities after 80', 'S-1-5-80-0-0-0-0'],
    ]) {
      it(`rejects ${label} (${value})`, () => {
        assert.deepEqual(checkSid(value), { code: EXIT_CONFIG_INVALID, lines: ['SERVICE_CONFIG=invalid:control_plane_sid'], stderr: '' });
      });
    }

    it('rejects a domain-style group (…-513), a SID the system cannot resolve, and a local group the user belongs to', (t) => {
      const rejected = { code: EXIT_CONFIG_INVALID, lines: ['SERVICE_CONFIG=invalid:control_plane_sid'], stderr: '' };
      assert.deepEqual(checkSid(`${domain()}-513`), rejected, '…-513 resolves to a group (None / Domain Users)');
      assert.deepEqual(checkSid(`${domain()}-4999999`), rejected, 'LookupAccountSid fails: closed');
      const groups = tokenGroupSids();
      if (groups.length === 0) return t.diagnostic('no S-1-5-21 local group in this token; local-group case not exercised here');
      for (const group of groups) assert.deepEqual(checkSid(group), rejected, `local group ${group}`);
    });
  });

  describe('serve loop (seam build, stdin EOF = SERVICE_CONTROL_STOP)', () => {
    function startLoop(name, { hold, overrides } = {}) {
      const s = scenario(name, overrides);
      const child = track(startProcess(loopExe, ['serve-loop', s.configFile, ...(hold ? [String(hold)] : [])], { stdin: true }));
      return { child, config: JSON.parse(readFileSync(s.configFile, 'utf8')), ...s };
    }
    async function stop(child) {
      const asked = Date.now();
      child.stdin.end();
      const code = await waitForExit(child);
      return { code, ms: Date.now() - asked };
    }
    /** 'claimed' when a listener could take the name, else the error code (EADDRINUSE, EACCES, ...). */
    const tryToTakeName = (pipe) => new Promise((resolve) => {
      const squatter = net.createServer((socket) => socket.destroy());
      squatter.once('error', (error) => resolve(error.code));
      squatter.listen(pipePath(pipe), () => squatter.close(() => resolve('claimed')));
    });

    it('finding 2: one pipe instance for the whole life of the loop, so a squatter between requests never gets the name and the Broker keeps serving', async () => {
      const { child, config } = startLoop('loop-squat-between');
      await waitForLine(child, 'BROKER_READY');
      const attempts = [];
      const requests = 12;
      for (let i = 0; i < requests; i += 1) {
        const reply = claim(config, child, `between-${i}`);
        // hammer the name while the request is served and in the moments right after it (the old dispose / recreate gap)
        for (let k = 0; k < 6; k += 1) attempts.push(await tryToTakeName(config.pipeName));
        assert.deepEqual(await reply, SUCCESS, `request ${i}`);
        for (let k = 0; k < 6; k += 1) attempts.push(await tryToTakeName(config.pipeName));
      }
      assert.equal(attempts.includes('claimed'), false, `a squatter took the name: ${attempts.join(',')}`);
      assert.ok(attempts.every((code) => typeof code === 'string' && code !== 'claimed'));
      assert.equal(child.closeCode, undefined, 'the Broker is still running');
      assert.equal(child.lines.some((line) => line.startsWith('BROKER_FATAL')), false, child.lines.join('|'));
      assert.equal(child.lines.filter((line) => line === 'BROKER_READY').length, 1);
      assert.deepEqual(await claim(config, child, 'between-last'), SUCCESS, 'still serving after all attempts');
      const stopped = await stop(child);
      assert.deepEqual([stopped.code, stopped.ms < STOP_BUDGET_MS], [0, true]);
      assert.equal(inspectClaimCount(brokerExe, config.database), requests + 1);
    });

    it('finding 4: STOP arriving while a claim is held still delivers the answer to that client, then the service stops within the grace', async () => {
      const { child, config } = startLoop('loop-stop-during-claim', { hold: 1500 });
      await waitForLine(child, 'BROKER_READY');
      const reply = claim(config, child, 'held');
      await waitForLine(child, 'CLAIM=PERSISTED_UNKNOWN'); // committed; the seam keeps it open for 1.5 s
      const stopping = stop(child);                         // SERVICE_CONTROL_STOP now
      assert.deepEqual(await reply, SUCCESS, 'the reply to a committed claim is not cancelled by STOP');
      const stopped = await stopping;
      assert.deepEqual([stopped.code, stopped.ms < STOP_BUDGET_MS], [0, true], `stopped in ${stopped.ms} ms`);
      assert.ok(child.lines.includes('BROKER_STOPPED'));
      assert.equal(child.lines.includes('REQUEST=ABORTED'), false);
      assert.equal(inspectClaimCount(brokerExe, config.database), 1);
    });

    // [label, overrides of the signed receipt]. Signed by the real authority key, so only the contract's strict reader and schema can stop them.
    const wrongTypes = [
      ['leaseGeneration as a string', { leaseGeneration: String(GENERATION) }], ['leaseGeneration as null', { leaseGeneration: null }], ['leaseGeneration as an object', { leaseGeneration: {} }],
      ['leaseGeneration with a fraction', { leaseGeneration: GENERATION + 0.5 }], ['exp as a string', { exp: String(Math.floor(Date.now() / 1000) + 120) }],
      ['exp as a boolean', { exp: true }], ['exp beyond int64', { exp: 1e30 }], ['brokerEpoch as an array', { brokerEpoch: [1] }], ['iat as null', { iat: null }],
    ];
    it('finding 5: a signed receipt whose number field has the wrong JSON type is denied (malformed / schema) and the service keeps serving', async () => {
      const { child, config } = startLoop('loop-wrong-types');
      await waitForLine(child, 'BROKER_READY');
      for (const [label, overrides] of wrongTypes) {
        assert.deepEqual(await claim(config, child, `wrong-${label.replaceAll(' ', '-')}`, overrides), DENIED, label);
        assert.equal(child.closeCode, undefined, `${label}: the process is still running`);
      }
      assert.deepEqual(await claim(config, child, 'after-wrong-types'), SUCCESS, 'a valid receipt is still served');
      assert.equal(child.lines.filter((line) => line === 'DENY=malformed' || line === 'DENY=schema').length, wrongTypes.length);
      assert.equal(child.lines.includes('REQUEST=DENIED'), false, 'a contract refusal is a plain denial, not an exception');
      assert.equal(child.lines.some((line) => line.startsWith('BROKER_FATAL')), false);
      assert.equal((await stop(child)).code, 0);
      assert.equal(inspectClaimCount(brokerExe, config.database), 1, 'only the valid receipt was claimed');
    });

    describe('accept condition C3: the database folder is pinned while the loop runs', () => {
      const SHARING_ERRORS = ['EBUSY', 'EPERM', 'EACCES']; // Windows reports a sharing violation on rename / rmdir as one of these, depending on the Node call
      const attempt = (action) => { try { action(); return 'succeeded'; } catch (error) { return error.code; } };

      it('rename and delete of the folder fail while the loop runs and succeed after STOP; service-check pins nothing', async () => {
        const { databaseDir, configFile, dir, database } = scenario('loop-pin-lifecycle');
        const moved = path.join(dir, 'db-moved');
        // Before the service starts (and after a service-check) the folder is free: the pin is the service's, not the check's.
        assert.equal(check(configFile).code, 0);
        assert.equal(attempt(() => renameSync(databaseDir, moved)), 'succeeded', 'control: nothing holds the folder before the service runs');
        renameSync(moved, databaseDir);
        const child = track(startProcess(loopExe, ['serve-loop', configFile], { stdin: true }));
        await waitForLine(child, 'BROKER_READY');
        assert.ok(SHARING_ERRORS.includes(attempt(() => renameSync(databaseDir, moved))), 'rename of the pinned folder');
        assert.equal(attempt(() => rmSync(databaseDir, { recursive: true })) === 'succeeded', false, 'delete of the pinned folder');
        assert.equal(existsSync(databaseDir), true);
        assert.equal(existsSync(database), true, 'the journal was created when the service started (the new epoch is written before RUNNING)');
        assert.equal(existsSync(moved), false);
        assert.equal(child.closeCode, undefined, 'the service is still running');
        assert.equal((await stop(child)).code, 0);
        assert.equal(attempt(() => renameSync(databaseDir, moved)), 'succeeded', 'after STOP the folder is released');
        renameSync(moved, databaseDir);
        assert.equal(attempt(() => rmSync(databaseDir, { recursive: true })), 'succeeded', 'after STOP the folder (with its journal) can be deleted');
      });

      it('the folder stays pinned across requests, requests keep using the same path, and the journal can still be read', async () => {
        const { child, config, databaseDir, dir } = startLoop('loop-pin-requests');
        const moved = path.join(dir, 'db-moved');
        await waitForLine(child, 'BROKER_READY');
        for (let i = 0; i < 3; i += 1) {
          assert.deepEqual(await claim(config, child, `pinned-${i}`), SUCCESS, `request ${i}`);
          assert.ok(SHARING_ERRORS.includes(attempt(() => renameSync(databaseDir, moved))), `rename after request ${i}`);
          assert.equal(attempt(() => rmSync(databaseDir, { recursive: true })) === 'succeeded', false, `recursive delete after request ${i} must not remove the folder`);
          assert.equal(existsSync(config.database), true, 'the journal file is still in the pinned folder');
        }
        assert.equal(inspectClaimCount(brokerExe, config.database), 3, 'the pin does not stop a reader from opening the journal');
        assert.deepEqual(await claim(config, child, 'pinned-last'), SUCCESS, 'still serving');
        assert.equal((await stop(child)).code, 0);
        assert.equal(inspectClaimCount(brokerExe, config.database), 4);
      });

      it('a parent of the pinned folder cannot be renamed while the loop runs either (recorded behaviour of NTFS, not something the Broker adds)', async () => {
        const { child, dir } = startLoop('loop-pin-parent');
        await waitForLine(child, 'BROKER_READY');
        const result = attempt(() => renameSync(dir, `${dir}-moved`));
        if (result === 'succeeded') renameSync(`${dir}-moved`, dir); // put it back so the cleanup finds it
        assert.ok(SHARING_ERRORS.includes(result), `parent rename gave: ${result}`);
        await stop(child);
      });
    });
  });
});
