import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listenFakeBroker, png } from './desktop-test-support.mjs';
import {
  brokerSession, buildBrokerWithTestSeams, buildPipeClient, buildServiceLab, createTestAuthority, currentUserSid, getUnavailableReason, makeTrustedTempDirectory, nodePipeOwnerSid,
  standInService, startProcess, waitForExit, waitForLine, GENERATION, LEASE_CONFIG,
} from '../helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged. The lab's driver for the REAL pipe client helper in desktop mode (`albera-lab-service-shim.exe desktop-helper ...`, DesktopHelperClient.cs): in the nested
// Hyper-V lab the guest has no Node, so this probe plays the Node client (src/runtime/windows-desktop-broker-client.mjs) and the helper (PR #168) does the identity checks and the talking.
// Three halves, no VM: a scripted Broker made in Node (every reply the driver must tell apart, and the arguments it must refuse), the REAL Broker service loop (seam build) for the success path of
// the open and the lease flow, and hostile same-user servers that must receive no byte. What this cannot show: `service:<name>` identities that resolve (need an SCM service; the unresolvable
// service is covered), the image of a SERVICE process (the lab), and a capture that succeeds against the real Broker (needs Hyper-V; the stand-in pipe covers the driver's PNG check).
const DENIED = { ok: false, code: 'denied' };
const OPENED = { ok: true };
const COMPUTER = 'lab-room';
const ROOM = 'room-1';
const NO_SUCH_VM = '0123abcd-4567-89ab-cdef-000000000001'; // a GUID no Hyper-V host has
const FOREIGN_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555';
const PLAIN_ARGS = { task: 'build the project' };

describe('lab driver for the real pipe client helper (shim `desktop-helper` probe)', { skip: getUnavailableReason(), timeout: 600_000 }, () => {
  let root, shim, loopExe, helper, sid, nodeOwner, nodeImage;
  const authority = createTestAuthority();
  const servers = new Set();
  const running = new Set();
  before(async () => {
    root = makeTrustedTempDirectory('albera-desktop-helper-');
    shim = buildServiceLab(path.join(root, 'shim'));
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
    nodeOwner = nodePipeOwnerSid();
    nodeImage = createHash('sha256').update(readFileSync(process.execPath)).digest('hex'); // the image behind every pipe this process serves
  });
  after(async () => {
    for (const server of servers) server.close();
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const unique = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
  const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const asPeer = (pid = process.pid, owner = nodeOwner) => `pid:${pid}:${owner}`;
  /** Runs the driver to the end: its JSON lines by id (and in order) and the exit code. */
  async function driver(args, helperPath = helper) {
    const child = startProcess(shim, ['desktop-helper', helperPath, ...args]);
    const code = await waitForExit(child);
    const lines = child.lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    return { code, lines, byId: Object.fromEntries(lines.map((line) => [line.id, line])) };
  }
  /** The Broker has a few pipe slots and recycles one when a session ends: a `broker_unavailable` between two sessions is a busy pipe, safe to retry (as `whileBusy` does for the claim pipe). */
  async function whileBusy(args) {
    for (let attempt = 0; ; attempt += 1) {
      const run = await driver(args);
      if (run.byId.open?.reply !== 'broker_unavailable' || attempt >= 40) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async function fakeBroker(script) {
    const { server, state } = await listenFakeBroker(`${unique('ALBERA_LabHelper')}_desktop`, script);
    servers.add(server);
    return state;
  }
  const view = (width, height, extra = []) => [`open:view:${COMPUTER}`, `capture:${width}x${height}`, ...extra];
  const LEASE_OPEN = `open:act:${COMPUTER}:lab-bd-act-1:1`; // names the generation
  const JOIN_OPEN = `open:act:${COMPUTER}:lab-bd-act-1`; // leaves it out: the Broker joins the current lease of the operation
  const picture = png(640, 480);
  const sendPicture = (connection) => { connection.send({ ok: true, width: 640, height: 480, bytes: picture.length }); connection.send(picture); };

  describe('against a scripted Broker (a stand-in desktop pipe this process owns; the helper identifies it by PID and owner)', () => {
    it('a view session: the helper is verified, the open is accepted, the capture is a PNG that is checked, hashed and saved; the Broker receives exactly the contract frames', async () => {
      const saved = path.join(root, 'saved.png');
      const broker = await fakeBroker((body, index, connection) => { if (index === 0) connection.send(OPENED); else sendPicture(connection); });
      const run = await driver([broker.pipe, asPeer(), ...view(640, 480, [`save=${saved}`])]);
      assert.equal(run.code, 0);
      assert.deepEqual(run.lines.map((line) => [line.id, line.ok]), [['helper', true], ['open', true], ['capture', true], ['close', true]]);
      assert.deepEqual([run.byId.helper.result, run.byId.helper.sha256], ['verified', sha256Of(helper)]);
      assert.deepEqual([run.byId.open.mode, run.byId.open.reply], ['view', 'accepted']);
      assert.deepEqual([run.byId.capture.reply, run.byId.capture.width, run.byId.capture.height, run.byId.capture.bytes, run.byId.capture.pngCheck], ['png', 640, 480, picture.length, 'signature_ihdr_iend_ok']);
      assert.equal(run.byId.capture.sha256, createHash('sha256').update(picture).digest('hex'));
      assert.deepEqual(readFileSync(saved), picture, 'the saved file is the PNG the Broker sent');
      assert.deepEqual([run.byId.close.helperExit, run.byId.close.stdoutExtraBytes], [0, 0], 'closing stdin ends the helper quietly, and it said nothing more');
      assert.deepEqual(broker.received, [`{"open":{"computerId":"${COMPUTER}","mode":"view"}}`, '{"capture":{"width":640,"height":480}}']);
    });

    // An act open is answered { ok: true, leaseGeneration: n }, the lease it joined; every other request with { ok: true }.
    const actBroker = (generation = 1) => fakeBroker((body, index, connection) => connection.send(index === 0 ? { ok: true, leaseGeneration: generation } : OPENED));

    it('an act session names its lease: the open and the input are exactly the frames the Broker takes, and the answer names the generation', async () => {
      const broker = await actBroker();
      const run = await driver([broker.pipe, asPeer(), LEASE_OPEN, 'input:tap=16', 'input:move=100,100+down=1+up=1']);
      assert.deepEqual(run.lines.map((line) => [line.id, line.ok]), [['helper', true], ['open', true], ['input', true], ['input_2', true], ['close', true]]);
      assert.deepEqual([run.byId.open.mode, run.byId.open.operationId, run.byId.open.leaseGeneration, run.byId.open.joinedGeneration, run.byId.input.reply], ['act', 'lab-bd-act-1', 1, 1, 'accepted']);
      assert.deepEqual(broker.received, [
        `{"open":{"computerId":"${COMPUTER}","mode":"act","operationId":"lab-bd-act-1","leaseGeneration":1}}`,
        '{"input":{"steps":[{"op":"tap","vk":16}]}}',
        '{"input":{"steps":[{"op":"move","x":100,"y":100},{"op":"down","button":1},{"op":"up","button":1}]}}',
      ]);
    });

    it('an act open can leave the generation out, as the room does: the frame has no leaseGeneration and the answer says which lease was joined', async () => {
      const broker = await actBroker(3);
      const run = await driver([broker.pipe, asPeer(), JOIN_OPEN, 'input:tap=16']);
      assert.deepEqual([run.byId.open.ok, run.byId.open.reply, run.byId.open.leaseGeneration, run.byId.open.joinedGeneration, run.byId.input.reply], [true, 'accepted', undefined, 3, 'accepted']);
      assert.deepEqual(broker.received, [`{"open":{"computerId":"${COMPUTER}","mode":"act","operationId":"lab-bd-act-1"}}`, '{"input":{"steps":[{"op":"tap","vk":16}]}}']);
    });

    it('an act open answered in any other way is not accepted: a bare ok, another generation than the one named, a generation that is not a lease, an extra member', async () => {
      const cases = [
        ['a bare ok', OPENED, LEASE_OPEN], ['another generation than the one named', { ok: true, leaseGeneration: 2 }, LEASE_OPEN], ['generation 0', { ok: true, leaseGeneration: 0 }, JOIN_OPEN],
        ['a generation that is not a number', { ok: true, leaseGeneration: '1' }, JOIN_OPEN], ['an extra member', { ok: true, leaseGeneration: 1, extra: 1 }, JOIN_OPEN],
      ];
      for (const [label, reply, open] of cases) {
        const broker = await fakeBroker((body, index, connection) => connection.send(reply));
        const run = await driver([broker.pipe, asPeer(), open, 'input:tap=16']);
        assert.deepEqual([run.byId.open.ok, run.byId.open.reply], [false, 'invalid_response'], label);
        assert.deepEqual([run.byId.input.skipped, run.byId.input.because], [true, 'open'], label);
        assert.equal(broker.received.length, 1, `${label}: nothing was sent after it`);
      }
      const denied = await fakeBroker((body, index, connection) => { connection.send(DENIED); connection.end(); });
      assert.equal((await driver([denied.pipe, asPeer(), JOIN_OPEN])).byId.open.reply, 'denied');
    });

    it('the image pin is the helper\'s: the hash of the process behind the pipe is accepted, any other hash is refused before a byte is sent', async () => {
      const broker = await fakeBroker((body, index, connection) => connection.send(OPENED));
      const right = await driver([broker.pipe, asPeer(), `open:view:${COMPUTER}`, `image=${nodeImage}`]);
      assert.deepEqual([right.byId.open.ok, right.byId.open.reply], [true, 'accepted']);
      const bytesBefore = broker.bytes;
      const wrong = await driver([broker.pipe, asPeer(), `open:view:${COMPUTER}`, `image=${'0'.repeat(64)}`]);
      assert.deepEqual([wrong.byId.open.ok, wrong.byId.open.reply], [false, 'server_identity_mismatch']);
      assert.equal(broker.bytes, bytesBefore, 'the refused session sent nothing');
    });

    it('sends nothing to a server that is not the expected one: another PID, another owner, a service that cannot be resolved; later steps are skipped', async () => {
      const broker = await fakeBroker((body, index, connection) => connection.send(OPENED));
      for (const [label, identity, expected] of [
        ['another PID', asPeer(process.pid + 1), 'server_identity_mismatch'], ['another owner', asPeer(process.pid, FOREIGN_SID), 'server_identity_mismatch'],
        ['a service that does not exist (what a stopped Broker looks like to the Control Plane)', 'service:AlberaNoSuchServiceForTheLab', 'server_identity_unavailable'],
      ]) {
        const run = await driver([broker.pipe, identity, ...view(640, 480)]);
        assert.deepEqual([run.byId.open.ok, run.byId.open.reply], [false, expected], label);
        assert.deepEqual([run.byId.capture.skipped, run.byId.capture.because], [true, 'open'], label);
        assert.equal(run.byId.close.ok, true, label);
      }
      assert.equal(broker.bytes, 0, 'not one byte reached the server');
      assert.deepEqual(broker.received, []);
    });

    it('tells the replies apart: the helper\'s own codes, a Broker that closes or answers with a frame that is not one of the fixed shapes', async () => {
      const cases = [
        ['the fixed denied frame', (c) => { c.send(DENIED); c.end(); }, 'denied'],
        ['closed without a frame', (c) => c.end(), 'invalid_response'],
        ['not json', (c) => c.send('not json'), 'invalid_response'],
        ['ok with an extra member', (c) => c.send({ ok: true, extra: 1 }), 'invalid_response'],
        ['denied with another code', (c) => c.send({ ok: false, code: 'busy' }), 'invalid_response'],
      ];
      for (const [label, reply, expected] of cases) {
        const broker = await fakeBroker((body, index, connection) => reply(connection));
        const run = await driver([broker.pipe, asPeer(), `open:view:${COMPUTER}`]);
        assert.deepEqual([run.byId.open.ok, run.byId.open.reply], [false, expected], label);
        assert.equal(run.byId.close.ok, true, label);
      }
      const absent = await driver([`${unique('ALBERA_LabHelperAbsent')}_desktop`, asPeer(), `open:view:${COMPUTER}`]);
      assert.deepEqual([absent.byId.open.ok, absent.byId.open.reply], [false, 'broker_unavailable']);
    });

    it('a capture is judged by the driver as well: a refusal, a header that is not the asked size, a PNG that is not valid or not the size it says', async () => {
      const cases = [
        ['denied', (c) => { c.send(DENIED); c.end(); }, 'denied'],
        ['a bare ok instead of a header', (c) => c.send(OPENED), 'invalid_response'],
        ['a header for another size', (c) => { c.send({ ok: true, width: 128, height: 64, bytes: picture.length }); c.send(picture); }, 'invalid'],
        ['a PNG whose last byte is damaged', (c) => { const bad = png(640, 480, { brokenEnd: true }); c.send({ ok: true, width: 640, height: 480, bytes: bad.length }); c.send(bad); }, 'png_invalid'],
        ['a PNG of another size', (c) => { const other = png(320, 240); c.send({ ok: true, width: 640, height: 480, bytes: other.length }); c.send(other); }, 'png_invalid'],
        ['the connection ending after the header', (c) => { c.send({ ok: true, width: 640, height: 480, bytes: picture.length }); c.end(); }, 'invalid_response'],
      ];
      for (const [label, reply, expected] of cases) {
        const saved = path.join(root, `never-${randomBytes(3).toString('hex')}.png`);
        const broker = await fakeBroker((body, index, connection) => { if (index === 0) connection.send(OPENED); else reply(connection); });
        const run = await driver([broker.pipe, asPeer(), ...view(640, 480, [`save=${saved}`])]);
        assert.equal(run.byId.open.ok, true, label);
        assert.deepEqual([run.byId.capture.ok, run.byId.capture.reply], [false, expected], label);
        assert.equal(existsSync(saved), false, `${label}: nothing is saved`);
      }
    });

    it('a helper that cannot be verified is never started: no manifest, or a manifest that names another hash', async () => {
      const broker = await fakeBroker((body, index, connection) => connection.send(OPENED));
      const stranger = path.join(root, 'stranger.exe');
      copyFileSync(process.execPath, stranger); // a real program, but not the helper
      const bare = await driver([broker.pipe, asPeer(), ...view(640, 480)], stranger);
      assert.deepEqual([bare.byId.helper.ok, bare.byId.helper.result], [false, 'helper_unavailable'], 'no manifest next to it');
      writeFileSync(`${stranger}.manifest.json`, JSON.stringify({ sha256: sha256Of(helper) }));
      const wrong = await driver([broker.pipe, asPeer(), ...view(640, 480)], stranger);
      assert.deepEqual([wrong.byId.helper.ok, wrong.byId.helper.result], [false, 'helper_unavailable'], 'a manifest that names another file');
      for (const run of [bare, wrong]) assert.deepEqual(run.lines.map((line) => [line.id, line.skipped ?? false]), [['helper', false], ['open', true], ['capture', true]]);
      assert.equal(broker.connections, 0, 'the pipe was never touched');
    });

    it('rejects malformed arguments with exit 64 before anything is started', async () => {
      const broker = await fakeBroker(() => {});
      const ok = [broker.pipe, asPeer()];
      const malformed = [
        [broker.pipe, asPeer()], [broker.pipe, asPeer(), 'capture:640x480'], [broker.pipe, asPeer(), `open:view:${COMPUTER}`, `open:view:${COMPUTER}`],
        [...ok, 'open:act:x'], [...ok, 'open:act:x:op:0'], [...ok, 'open:act:x:bad id'], [...ok, 'open:view:x:op'], [...ok, 'open:act:x:op:1:extra'],[...ok, 'open:edit:x'], [...ok, `open:view:${COMPUTER}`, 'claim'], [...ok, `open:view:${COMPUTER}`, 'end:2000'],
        [...ok, `open:view:${COMPUTER}`, `image=${'A'.repeat(64)}`], [...ok, `open:view:${COMPUTER}`, 'image=abc'],
        ['not_a_desktop_pipe', asPeer(), `open:view:${COMPUTER}`], ['bad/name_desktop', asPeer(), `open:view:${COMPUTER}`],
        [broker.pipe, 'owner:x', `open:view:${COMPUTER}`], [broker.pipe, `pid:0:${nodeOwner}`, `open:view:${COMPUTER}`], [broker.pipe, `pid:abc:${nodeOwner}`, `open:view:${COMPUTER}`],
        [broker.pipe, 'pid:5:not-a-sid', `open:view:${COMPUTER}`], [broker.pipe, `pid:5`, `open:view:${COMPUTER}`], [broker.pipe, 'service:bad name', `open:view:${COMPUTER}`],
      ];
      for (const args of malformed) {
        const run = await driver(args);
        assert.deepEqual([run.code, run.lines], [64, []], JSON.stringify(args));
      }
      const relative = await driver([broker.pipe, asPeer(), `open:view:${COMPUTER}`], 'albera-windows-broker-pipe-client.exe');
      assert.deepEqual([relative.code, relative.lines], [64, []], 'the helper is named by a full path');
      assert.equal(broker.connections, 0);
    });
  });

  describe('against hostile same-user servers (the squat probe): not one byte', () => {
    async function squatter() {
      const pipe = `${unique('ALBERA_LabHelperSquat')}_desktop`;
      const child = startProcess(shim, ['squat', pipe, '20']);
      running.add(child);
      const ready = JSON.parse(await waitForLine(child, /"state":"ready"/u));
      return { pipe, child, ready };
    }
    const done = async (child) => {
      await waitForExit(child);
      return child.lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((line) => line.state === 'done');
    };

    it('the right owner but not its PID, and its PID but not its owner: the helper connects, finds out, ends with server_identity_mismatch, and the squatter has been sent nothing', async () => {
      const wrongPid = await squatter();
      const byPid = await driver([wrongPid.pipe, `pid:${process.pid}:${wrongPid.ready.owner}`, `open:view:${COMPUTER}`]);
      assert.deepEqual([byPid.byId.open.ok, byPid.byId.open.reply], [false, 'server_identity_mismatch']);
      assert.deepEqual(await done(wrongPid.child), { probe: 'squat', state: 'done', connected: true, bytesReceived: 0 });

      const wrongOwner = await squatter();
      const byOwner = await driver([wrongOwner.pipe, `pid:${wrongOwner.ready.pid}:${FOREIGN_SID}`, `open:view:${COMPUTER}`]);
      assert.deepEqual([byOwner.byId.open.ok, byOwner.byId.open.reply], [false, 'server_identity_mismatch']);
      assert.deepEqual(await done(wrongOwner.child), { probe: 'squat', state: 'done', connected: true, bytesReceived: 0 });

      // The control, so that "0 bytes" is not vacuous: a squatter that is named truthfully is believed, the helper sends its open, and the squatter does count it.
      const named = await squatter();
      const believed = await driver([named.pipe, `pid:${named.ready.pid}:${named.ready.owner}`, `open:view:${COMPUTER}`]);
      assert.equal(believed.byId.open.ok, false, 'the squatter says nothing back');
      assert.notEqual(believed.byId.open.reply, 'server_identity_mismatch');
      const seen = await done(named.child);
      assert.ok(seen.bytesReceived > 0, 'the squat probe counts what it is sent');
    });
  });

  describe('against the real Broker service loop (seam build, no VM) and the real helper', () => {
    const pipeName = unique('ALBERA_LabHelperReal');
    const desktop = `${pipeName}_desktop`;
    let child, claims;
    const logged = (prefix) => child.lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
    const opened = () => child.lines.filter((line) => line === 'DESKTOP=OPENED').length;
    async function until(condition, what, ms = 10_000) {
      for (const limit = Date.now() + ms; !condition();) {
        assert.ok(Date.now() < limit, `timeout: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    /** A task.start claim over the real claim pipe: the only thing that makes a lease. Returns its operationId. */
    async function claimTaskStart(name) {
      const prepared = await claims.prepare(name, { purpose: 'guest.command', action: 'task.start', args: PLAIN_ARGS, computerId: ROOM });
      assert.deepEqual(await claims.send({ ...prepared, action: { action: 'task.start', projectId: 'project-1', computerId: ROOM, args: PLAIN_ARGS } }), { ok: true, state: 'UNKNOWN', action: 'task.start' });
      return `${name}-op`;
    }

    before(async () => {
      const file = path.join(root, 'real.config.json');
      writeFileSync(file, JSON.stringify({
        pipeName, database: path.join(root, 'real.sqlite'), authorityKeys: [authority.keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG,
        computers: [{ computerId: ROOM, vmId: NO_SUCH_VM }],
      }));
      child = startProcess(loopExe, standInService('serve-loop', file), { stdin: true });
      running.add(child);
      await waitForLine(child, 'BROKER_READY');
      claims = brokerSession({ helper, sid, pipeName, pid: child.pid, authority });
    });
    after(() => { child?.stdin.end(); });

    it('a view session through the helper: the open is accepted (with and without the image pin), the capture of a VM the host does not have ends in the fixed denied, the Broker logs why', async () => {
      const peer = asPeer(child.pid, sid);
      const run = await whileBusy([desktop, peer, `open:view:${ROOM}`, 'capture:640x480']);
      assert.deepEqual([run.byId.open.ok, run.byId.open.reply], [true, 'accepted']);
      assert.deepEqual([run.byId.capture.ok, run.byId.capture.reply], [false, 'denied']);
      assert.deepEqual([run.byId.close.ok, run.byId.close.stdoutExtraBytes], [true, 0]);
      await until(() => logged('DESKTOP_DENY=').length === 1, 'the logged reason');
      assert.deepEqual(logged('DESKTOP_DENY='), ['desktop_unavailable']);

      const pinned = await whileBusy([desktop, peer, `open:view:${ROOM}`, `image=${sha256Of(loopExe)}`]);
      assert.deepEqual([pinned.byId.open.ok, pinned.byId.open.reply], [true, 'accepted'], 'the image behind the pipe is the Broker file');
    });

    it('a wrong image pin is refused by the helper before it writes: the Broker accepts a connection and sees no open', async () => {
      const before = opened();
      const run = await whileBusy([desktop, asPeer(child.pid, sid), `open:view:${ROOM}`, `image=${sha256Of(helper)}`]);
      assert.deepEqual([run.byId.open.ok, run.byId.open.reply], [false, 'server_identity_mismatch']);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(opened(), before, 'no session was opened');
    });

    it('the lease flow through the helper, as the room walks it: an open without a generation is refused before a claim and joins the lease after it (the answer names generation 1), the keyboard input reaches the adapter, a named wrong generation is refused', async () => {
      const peer = asPeer(child.pid, sid);
      const join = (operationId) => `open:act:${ROOM}:${operationId}`;
      const lease = (operationId, generation) => `open:act:${ROOM}:${operationId}:${generation}`;

      const unclaimed = await whileBusy([desktop, peer, join('first-op')]);
      assert.deepEqual([unclaimed.byId.open.ok, unclaimed.byId.open.reply], [false, 'denied']);
      await until(() => logged('DESKTOP_DENY=').includes('lease_unknown'), 'lease_unknown');

      const operationId = await claimTaskStart('first');
      assert.equal(operationId, 'first-op');
      const act = await whileBusy([desktop, peer, join(operationId), 'input:tap=16']);
      assert.deepEqual([act.byId.open.ok, act.byId.open.reply, act.byId.open.joinedGeneration], [true, 'accepted', 1]);
      const named = await whileBusy([desktop, peer, lease(operationId, 1)]);
      assert.deepEqual([named.byId.open.ok, named.byId.open.joinedGeneration], [true, 1], 'naming the right generation is accepted too');
      assert.deepEqual([act.byId.input.ok, act.byId.input.reply], [false, 'denied'], 'no VM behind the room: the adapter is where it ends');
      await until(() => child.lines.includes('DESKTOP_TEST=input_enter'), 'the input reaching the adapter');
      assert.ok(child.lines.includes('DESKTOP=ACT'), 'the act open was accepted');
      assert.equal(logged('DESKTOP_DENY=').at(-1), 'desktop_unavailable');

      const wrong = await whileBusy([desktop, peer, lease(operationId, 2)]);
      assert.deepEqual([wrong.byId.open.ok, wrong.byId.open.reply], [false, 'denied']);
      await until(() => logged('DESKTOP_DENY=').at(-1) === 'lease_generation', 'lease_generation');
    });

    it('a Broker whose PID is not the one named, and a service name that does not resolve, are refused before a byte', async () => {
      const wrongPid = await whileBusy([desktop, asPeer(child.pid + 1, sid), `open:view:${ROOM}`]);
      assert.deepEqual([wrongPid.byId.open.ok, wrongPid.byId.open.reply], [false, 'server_identity_mismatch']);
      const noService = await whileBusy([desktop, 'service:AlberaNoSuchServiceForTheLab', `open:view:${ROOM}`]);
      assert.deepEqual([noService.byId.open.ok, noService.byId.open.reply], [false, 'server_identity_unavailable']);
    });
  });
});
