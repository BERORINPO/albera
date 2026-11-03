import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { listenFakeBroker, png } from './desktop-test-support.mjs';
import { runWithGuestFunctions } from './guest-functions.mjs';
import {
  brokerSession, buildBrokerWithTestSeams, buildPipeClient, buildServiceLab, createTestAuthority, currentUserSid, getUnavailableReason, makeTrustedTempDirectory, nodePipeOwnerSid,
  standInService, startProcess, waitForExit, waitForLine, GENERATION, LEASE_CONFIG, LEASE_ID, POLICY_VERSION,
} from '../helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged. The lab's client of the Broker's desktop pipe (`albera-lab-service-shim.exe desktop ...`, DesktopClient.cs), which the nested Hyper-V lab runs as the
// Control Plane and as another caller. Two halves: a scripted fake Broker made in Node (every reply the client must tell apart, including the ones the real Broker never sends: a bad PNG,
// a wrong size, a short frame, a wrong server), and the REAL Broker service loop (seam build, no VM: a capture ends in the fixed denied reply) for the wire format itself.
// What this cannot show: the success path against the real Broker (needs Hyper-V, that is the lab) and `service:<name>` identities (need an SCM service).
const DENIED = { ok: false, code: 'denied' };
const OPENED = { ok: true };
const COMPUTER = 'lab-room';
const FOREIGN_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555';

describe('lab desktop-pipe client (shim `desktop` probe)', { skip: getUnavailableReason() }, () => {
  let root, shim, loopExe, sid, nodeOwner;
  const authority = createTestAuthority();
  const servers = new Set();
  const running = new Set();
  before(() => {
    root = makeTrustedTempDirectory('albera-desktop-client-');
    shim = buildServiceLab(path.join(root, 'shim'));
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    sid = currentUserSid();
    nodeOwner = nodePipeOwnerSid();
  });
  after(async () => {
    for (const server of servers) server.close();
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const unique = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
  /** Runs the client to the end and returns its JSON lines by id (and in order) plus the exit code. */
  async function client(args) {
    const child = startProcess(shim, ['desktop', ...args]);
    const code = await waitForExit(child);
    const lines = child.lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    return { code, lines, byId: Object.fromEntries(lines.map((line) => [line.id, line])), raw: child.lines };
  }

  /**
   * A fake Broker on a pipe this process owns. `script(body, index, connection)` runs for every request frame; `connection.send(x)` writes a frame, `connection.end()` closes. `received` is every
   * request body (as text), `bytes` the number of bytes any client sent.
   */
  async function fakeBroker(script) {
    const { server, state } = await listenFakeBroker(unique('ALBERA_LabDesk'), script);
    servers.add(server);
    return state;
  }
  const asPeer = (pid = process.pid, owner = nodeOwner) => `pid:${pid}:${owner}`;
  const view = (width, height, extra = []) => [`open:view:${COMPUTER}`, `capture:${width}x${height}`, ...extra];

  describe('against a scripted Broker', () => {
    it('opens a view session and takes a capture: the PNG is checked, hashed and saved; the requests are exactly the contract frames', async () => {
      const picture = png(64, 64);
      const saved = path.join(root, 'saved.png');
      const broker = await fakeBroker((body, index, connection) => {
        if (index === 0) connection.send(OPENED);
        else { connection.send({ ok: true, width: 64, height: 64, bytes: picture.length }); connection.send(picture); }
      });
      const run = await client([broker.pipe, asPeer(), ...view(64, 64, [`save=${saved}`])]);
      assert.equal(run.code, 0);
      assert.deepEqual(run.lines.map((line) => [line.id, line.ok]), [['connect', true], ['open', true], ['capture', true]]);
      assert.equal(run.byId.connect.result, 'connected');
      assert.deepEqual([run.byId.open.mode, run.byId.open.reply], ['view', 'accepted']);
      assert.deepEqual([run.byId.capture.reply, run.byId.capture.width, run.byId.capture.height, run.byId.capture.bytes, run.byId.capture.pngCheck], ['png', 64, 64, picture.length, 'signature_ihdr_iend_ok']);
      assert.equal(run.byId.capture.sha256, createHash('sha256').update(picture).digest('hex'));
      assert.deepEqual(readFileSync(saved), picture, 'the saved file is the PNG the Broker sent');
      assert.deepEqual(broker.received, [`{"open":{"computerId":"${COMPUTER}","mode":"view"}}`, '{"capture":{"width":64,"height":64}}']);
    });

    it('does not save a picture that is not a valid PNG', async () => {
      const bad = png(64, 64, { brokenEnd: true });
      const saved = path.join(root, 'never.png');
      const broker = await fakeBroker((body, index, connection) => {
        if (index === 0) connection.send(OPENED); else { connection.send({ ok: true, width: 64, height: 64, bytes: bad.length }); connection.send(bad); }
      });
      const run = await client([broker.pipe, asPeer(), ...view(64, 64, [`save=${saved}`])]);
      assert.deepEqual([run.byId.capture.ok, run.byId.capture.reply, run.byId.capture.pngCheck], [false, 'png_invalid', 'bad_iend']);
      assert.equal(existsSync(saved), false);
    });

    it('an act open that the Broker refuses is reported as denied, and the session stops there', async () => {
      const broker = await fakeBroker((body, index, connection) => { connection.send(DENIED); connection.end(); });
      const run = await client([broker.pipe, asPeer(), `open:act:${COMPUTER}`, 'capture:640x480']);
      assert.deepEqual([run.byId.open.ok, run.byId.open.mode, run.byId.open.reply], [false, 'act', 'denied']);
      assert.deepEqual([run.byId.capture.ok, run.byId.capture.skipped, run.byId.capture.because], [false, true, 'open']);
      assert.deepEqual(broker.received, [`{"open":{"computerId":"${COMPUTER}","mode":"act"}}`], 'only the open was sent');
    });

    it('tells the replies apart: closed without a frame, a frame that is not the fixed shape, an oversize frame, a capture header that is not one', async () => {
      const cases = [
        ['closed', (c) => c.end(), 'closed'],
        ['not json', (c) => c.send('not json'), 'invalid'],
        ['ok with an extra member', (c) => c.send({ ok: true, extra: 1 }), 'invalid'],
        ['denied with another code', (c) => c.send({ ok: false, code: 'busy' }), 'invalid'],
        ['ok false without a code', (c) => c.send({ ok: false }), 'invalid'],
        ['a length beyond the reply bound', (c) => c.sendRaw(Buffer.concat([Buffer.from([0x01, 0x01, 0x00, 0x00]), Buffer.alloc(8)])), 'invalid'],
        ['a zero length', (c) => c.sendRaw(Buffer.alloc(4)), 'invalid'],
      ];
      for (const [label, reply, expected] of cases) {
        const broker = await fakeBroker((body, index, connection) => reply(connection));
        const run = await client([broker.pipe, asPeer(), `open:view:${COMPUTER}`]);
        assert.deepEqual([run.byId.open.ok, run.byId.open.reply], [false, expected], label);
      }
    });

    it('a capture reply must be a header for the asked size followed by exactly `bytes` bytes of PNG', async () => {
      const picture = png(64, 64);
      const cases = [
        ['a bare ok instead of a header', (c) => c.send(OPENED), 'invalid'],
        ['a header for another size', (c) => c.send({ ok: true, width: 128, height: 64, bytes: picture.length }), 'invalid'],
        ['a header with an extra member', (c) => c.send({ ok: true, width: 64, height: 64, bytes: picture.length, extra: 1 }), 'invalid'],
        ['a header that promises more than the PNG frame holds', (c) => { c.send({ ok: true, width: 64, height: 64, bytes: picture.length + 1 }); c.send(picture); }, 'invalid'],
        ['a header that promises more than the bound', (c) => c.send({ ok: true, width: 64, height: 64, bytes: 8 * 1024 * 1024 + 1 }), 'invalid'],
        ['a PNG frame longer than the bound', (c) => { c.send({ ok: true, width: 64, height: 64, bytes: 100 }); c.sendRaw(Buffer.from([0x01, 0x00, 0x80, 0x00])); }, 'invalid'],
        ['a PNG of another size', (c) => { const other = png(32, 32); c.send({ ok: true, width: 64, height: 64, bytes: other.length }); c.send(other); }, 'png_invalid'],
        ['the connection ending after the header', (c) => { c.send({ ok: true, width: 64, height: 64, bytes: picture.length }); c.end(); }, 'closed'],
        ['the fixed denied frame', (c) => { c.send(DENIED); c.end(); }, 'denied'],
      ];
      for (const [label, reply, expected] of cases) {
        const broker = await fakeBroker((body, index, connection) => { if (index === 0) connection.send(OPENED); else reply(connection); });
        const run = await client([broker.pipe, asPeer(), ...view(64, 64)]);
        assert.equal(run.byId.open.ok, true, label);
        assert.deepEqual([run.byId.capture.ok, run.byId.capture.reply], [false, expected], label);
      }
    });

    it('sends nothing to a server that is not the expected one: another PID, another owner, or an unusable identity', async () => {
      const broker = await fakeBroker((body, index, connection) => connection.send(OPENED));
      for (const [label, identity] of [
        ['another PID', asPeer(process.pid + 1)], ['another owner', asPeer(process.pid, FOREIGN_SID)],
        ['a PID that is not a number', `pid:abc:${nodeOwner}`], ['no owner', `pid:${process.pid}`], ['an unknown scheme', 'owner:x'], ['a service that does not exist', 'service:AlberaNoSuchServiceForTheLab'],
      ]) {
        const run = await client([broker.pipe, identity, ...view(64, 64)]);
        assert.equal(run.byId.connect.ok, false, label);
        assert.match(run.byId.connect.result, /^server_identity_(mismatch|unavailable)$/u, label);
        assert.deepEqual([run.byId.open.skipped, run.byId.open.because, run.byId.capture.skipped], [true, 'connect', true], label);
      }
      assert.equal(broker.bytes, 0, 'not one byte reached the server');
      assert.deepEqual(broker.received, []);
    });

    it('reports a pipe that is not there, and rejects malformed arguments with exit 64 before touching any pipe', async () => {
      const absent = await client([unique('ALBERA_LabDeskAbsent'), asPeer(), `open:view:${COMPUTER}`]);
      assert.deepEqual([absent.byId.connect.ok, absent.byId.connect.result], [false, 'broker_unavailable']);
      const broker = await fakeBroker(() => {});
      const malformed = [
        ['open:edit:x'], ['open:view'], ['open:view:bad id'], ['capture:640'], ['capture:0x480'], ['capture:axb'], ['input:x'], [], ['save=x'],
        ['open:act:x:op'], ['open:act:x:op:0'], ['open:act:x:op:-1'], ['open:act:x:op:1.5'], ['open:act:x:bad id:1'], ['open:act:x:op:1:extra'], ['open:view:x:op:1'],
        ['input:'], ['input:tap'], ['input:tap=1,2'], ['input:move=1'], ['input:move=1,2,3'], ['input:fly=1'], ['input:tap=a'], ['input:tap=1++tap=2'], ['input:text=abc'],
        [`input:${Array.from({ length: 65 }, () => 'tap=16').join('+')}`],
        ['end'], ['end:999'], ['end:60001'], ['end:soon'], ['claim'], ['claim', 'claim-exe=x'], ['claim', 'claim-stdin=y'], ['claim-exe=x', 'claim-stdin=y'],
      ];
      for (const args of malformed) {
        const run = await client([broker.pipe, asPeer(), ...args]);
        assert.equal(run.code, 64, JSON.stringify(args));
        assert.deepEqual(run.lines, [], JSON.stringify(args));
      }
      assert.equal((await client(['bad/name', asPeer(), `open:view:${COMPUTER}`])).code, 64);
      assert.equal(broker.connections, 0);
    });

    it('numbers a repeated step (capture, capture_2) so a longer session can be read line by line', async () => {
      const picture = png(64, 64);
      const broker = await fakeBroker((body, index, connection) => {
        if (index === 0) connection.send(OPENED); else { connection.send({ ok: true, width: 64, height: 64, bytes: picture.length }); connection.send(picture); }
      });
      const run = await client([broker.pipe, asPeer(), `open:view:${COMPUTER}`, 'capture:64x64', 'capture:64x64']);
      assert.deepEqual(run.lines.map((line) => [line.id, line.ok]), [['connect', true], ['open', true], ['capture', true], ['capture_2', true]]);
    });

    const LEASE_OPEN = `open:act:${COMPUTER}:lab-bd-act-1:1`;

    it('an act open that names its lease sends exactly the contract frame, and an accepted one is followed by input requests that are exactly the Broker\'s frames', async () => {
      const broker = await fakeBroker((body, index, connection) => connection.send(OPENED));
      const run = await client([broker.pipe, asPeer(), LEASE_OPEN, 'input:tap=16', 'input:move=100,100+down=1+up=1+press=65+release=65+wheel=-120+sleep=50']);
      assert.deepEqual(run.lines.map((line) => [line.id, line.ok]), [['connect', true], ['open', true], ['input', true], ['input_2', true]]);
      assert.deepEqual([run.byId.open.mode, run.byId.open.operationId, run.byId.open.leaseGeneration, run.byId.open.reply], ['act', 'lab-bd-act-1', 1, 'accepted']);
      assert.deepEqual([run.byId.input.reply, run.byId.input_2.reply], ['accepted', 'accepted']);
      assert.deepEqual(broker.received, [
        `{"open":{"computerId":"${COMPUTER}","mode":"act","operationId":"lab-bd-act-1","leaseGeneration":1}}`,
        '{"input":{"steps":[{"op":"tap","vk":16}]}}',
        '{"input":{"steps":[{"op":"move","x":100,"y":100},{"op":"down","button":1},{"op":"up","button":1},{"op":"press","vk":65},{"op":"release","vk":65},{"op":"wheel","delta":-120},{"op":"sleep","ms":50}]}}',
      ]);
      for (const body of broker.received) assert.doesNotThrow(() => JSON.parse(body));
    });

    it('a refused input ends the session there: the next input is skipped and never sent; the keyboard request is judged apart from the mouse request that follows it', async () => {
      const broker = await fakeBroker((body, index, connection) => {
        if (index === 0 || index === 1) connection.send(OPENED);
        else { connection.send(DENIED); connection.end(); }
      });
      const run = await client([broker.pipe, asPeer(), LEASE_OPEN, 'input:tap=16', 'input:move=100,100+down=1+up=1', 'input:tap=16']);
      assert.deepEqual(run.lines.map((line) => [line.id, line.ok]), [['connect', true], ['open', true], ['input', true], ['input_2', false], ['input_3', false]]);
      assert.deepEqual([run.byId.input_2.reply, run.byId.input_3.skipped, run.byId.input_3.because], ['denied', true, 'input_2']);
      assert.equal(broker.received.length, 3, 'the third input was not sent');
    });

    it('tells the replies to an input apart, as it does for an open', async () => {
      const cases = [['denied', (c) => { c.send(DENIED); c.end(); }], ['closed', (c) => c.end()], ['invalid', (c) => c.send({ ok: true, extra: 1 })]];
      for (const [expected, reply] of cases) {
        const broker = await fakeBroker((body, index, connection) => { if (index === 0) connection.send(OPENED); else reply(connection); });
        const run = await client([broker.pipe, asPeer(), LEASE_OPEN, 'input:tap=16']);
        assert.deepEqual([run.byId.input.ok, run.byId.input.reply], [false, expected], expected);
      }
    });

    it('end: reports the frame the Broker sends by itself (without sending anything), and `timeout` when none comes, after which the process still exits', async () => {
      const ended = await fakeBroker((body, index, connection) => { connection.send(OPENED); setTimeout(() => { connection.send(DENIED); connection.end(); }, 300); });
      const withEnd = await client([ended.pipe, asPeer(), LEASE_OPEN, 'end:5000']);
      assert.deepEqual([withEnd.byId.end.ok, withEnd.byId.end.reply], [false, 'denied']);
      assert.deepEqual(ended.received, [`{"open":{"computerId":"${COMPUTER}","mode":"act","operationId":"lab-bd-act-1","leaseGeneration":1}}`], 'the end step sends nothing');

      const closed = await fakeBroker((body, index, connection) => { connection.send(OPENED); setTimeout(() => connection.end(), 200); });
      assert.deepEqual((await client([closed.pipe, asPeer(), LEASE_OPEN, 'end:5000'])).byId.end.reply, 'closed');

      const silent = await fakeBroker((body, index, connection) => connection.send(OPENED));
      const started = Date.now();
      const waited = await client([silent.pipe, asPeer(), LEASE_OPEN, 'end:1000']);
      assert.deepEqual([waited.code, waited.byId.end.ok, waited.byId.end.reply], [0, false, 'timeout']);
      assert.ok(Date.now() - started < 20_000, 'the abandoned read does not hold the process');
    });

    describe('claim: the Control Plane helper runs as a child of the client', () => {
      // A stand-in for the helper: node reads its program from stdin, so the stdin file says what the "helper" prints. The real helper is exercised against the real Broker below.
      const claimWith = async (script, extra = []) => {
        const stdin = path.join(root, `claim-${randomBytes(4).toString('hex')}.js`);
        writeFileSync(stdin, script);
        const broker = await fakeBroker((body, index, connection) => connection.send(OPENED));
        return { broker, ...(await client([broker.pipe, asPeer(), LEASE_OPEN, 'claim', ...extra, `claim-exe=${process.execPath}`, `claim-stdin=${stdin}`])) };
      };
      const printing = (value) => `console.log(${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))});`;

      it('a recorded claim is `claimed` with its state and action, and says whether it was a replay', async () => {
        const run = await claimWith(printing({ ok: true, state: 'UNKNOWN', action: 'task.start' }));
        assert.deepEqual([run.byId.claim.ok, run.byId.claim.reply, run.byId.claim.state, run.byId.claim.action, run.byId.claim.replayed, run.byId.claim.helperExit], [true, 'claimed', 'UNKNOWN', 'task.start', false, 0]);
        const replay = await claimWith(printing({ ok: true, state: 'UNKNOWN', action: 'task.start', replayed: true }));
        assert.equal(replay.byId.claim.replayed, true);
      });

      it('a refusal is the helper\'s code; anything that is not one of its replies is `invalid`; a program that is not there is `helper_unavailable`', async () => {
        assert.deepEqual([(await claimWith(printing({ ok: false, code: 'denied' }))).byId.claim.reply], ['denied']);
        assert.deepEqual([(await claimWith(printing({ ok: false, code: 'server_identity_mismatch' }))).byId.claim.reply], ['server_identity_mismatch']);
        for (const [label, script] of [['text', printing('hello')], ['an array', printing('[1]')], ['no ok', printing({ state: 'UNKNOWN' })], ['a code that is not a plain word', printing({ ok: false, code: 'x y' })], ['no output', '']]) {
          const run = await claimWith(script);
          assert.deepEqual([run.byId.claim.ok, run.byId.claim.reply], [false, 'invalid'], label);
        }
        const stdin = path.join(root, 'claim-none.js');
        writeFileSync(stdin, '');
        const broker = await fakeBroker((body, index, connection) => connection.send(OPENED));
        const missing = await client([broker.pipe, asPeer(), LEASE_OPEN, 'claim', `claim-exe=${path.join(root, 'no-such-helper.exe')}`, `claim-stdin=${stdin}`]);
        assert.deepEqual([missing.byId.claim.ok, missing.byId.claim.reply], [false, 'helper_unavailable']);
      });

      it('a claim that fails does not stop the steps after it: the session does not depend on it', async () => {
        const run = await claimWith(printing({ ok: false, code: 'denied' }), ['input:tap=16']);
        assert.deepEqual(run.lines.map((line) => [line.id, line.ok]), [['connect', true], ['open', true], ['claim', false], ['input', true]]);
      });
    });
  });

  describe('the config the lab writes for the Broker', () => {
    it('is accepted by the real Broker\'s config check (inner VM as the one computer, lowercase GUID, a well-formed pinned key), and the desktop pipe name follows the Broker\'s rule', () => {
      const guestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lab-hyperv-rights-check.ps1');
      const guestText = readFileSync(guestPath, 'utf8');
      const constant = (name) => new RegExp(`^\\$${name} = '([^']+)'`, 'mu').exec(guestText)[1];
      const written = path.join(root, 'lab-written.config.json');
      const vmId = '0123ABCD-4567-89AB-CDEF-000000000002';   // as Get-VM prints it; the lab lowercases it
      // Write-BdBrokerConfig reads the script-level names of the lab script, so they are taken from its text and handed over, never copied into this test.
      runWithGuestFunctions(guestPath, ['Write-BdBrokerConfig', 'New-LabAuthority'],
        `$BdPipe = $cases.pipe; $BdComputerId = $cases.computerId; $BdLeaseId = $cases.leaseId; $BdPolicyVersion = $cases.policyVersion
         $authority = New-LabAuthority $cases.kid
         Write-BdBrokerConfig $cases.path $cases.database $cases.cpSid $cases.vmId $authority; Write-Output '{}'`,
        {
          pipe: constant('BdPipe'), computerId: constant('BdComputerId'), leaseId: constant('BdLeaseId'), policyVersion: constant('BdPolicyVersion'), kid: constant('BdAuthorityKid'),
          path: written, database: path.join(root, 'lab-written.sqlite'), cpSid: FOREIGN_SID, vmId,
        });
      const config = JSON.parse(readFileSync(written, 'utf8'));
      assert.deepEqual(config.computers, [{ computerId: constant('BdComputerId'), vmId: vmId.toLowerCase() }]);
      assert.equal(config.controlPlaneSid, FOREIGN_SID);
      assert.deepEqual([config.leaseId, config.policyVersion, config.authorityKeys[0].kid], [constant('BdLeaseId'), constant('BdPolicyVersion'), constant('BdAuthorityKid')]);
      const check = (file) => spawnSync(loopExe, standInService('service-check', file), { encoding: 'utf8', windowsHide: true }).stdout.trim();
      assert.equal(check(written), 'SERVICE_CONFIG=ok');
      assert.match(guestText, /\$BdDesktopPipe = "\$\{BdPipe\}_desktop"/u, 'ServiceConfig.DesktopPipeName: the claim pipe name + _desktop');
      // The check above is not vacuous: the same file with a VM id that is not a GUID is refused for exactly that.
      const notAGuid = path.join(root, 'lab-no-vm.config.json');
      writeFileSync(notAGuid, JSON.stringify({ ...config, computers: [{ computerId: 'x', vmId: 'NOT-A-GUID' }] }));
      assert.equal(check(notAGuid), 'SERVICE_CONFIG=invalid:computers');
    });
  });

  describe('against the real Broker service loop (seam build, no VM)', () => {
    const pipeName = unique('ALBERA_LabDeskReal');
    let child;
    before(async () => {
      const config = {
        pipeName, database: path.join(root, 'real.sqlite'), authorityKeys: [authority.keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG,
        computers: [{ computerId: COMPUTER, vmId: '0123abcd-4567-89ab-cdef-000000000001' }],   // a GUID no Hyper-V host has
      };
      const file = path.join(root, 'real.config.json');
      writeFileSync(file, JSON.stringify(config));
      child = startProcess(loopExe, standInService('serve-loop', file), { stdin: true });
      running.add(child);
      await waitForLine(child, 'BROKER_READY');
    });
    after(() => { child?.stdin.end(); });

    it('accepts a view open from the Control Plane SID; the capture of a VM the host does not have ends in the fixed denied reply', async () => {
      const run = await client([`${pipeName}_desktop`, asPeer(child.pid, sid), ...view(640, 480)]);
      assert.equal(run.byId.connect.result, 'connected');
      assert.deepEqual([run.byId.open.ok, run.byId.open.reply], [true, 'accepted']);
      assert.deepEqual([run.byId.capture.ok, run.byId.capture.reply], [false, 'denied']);
    });

    it('refuses an act open with the fixed denied reply, and does not take the view session down for the next client', async () => {
      const act = await client([`${pipeName}_desktop`, asPeer(child.pid, sid), `open:act:${COMPUTER}`]);
      assert.deepEqual([act.byId.connect.result, act.byId.open.ok, act.byId.open.reply], ['connected', false, 'denied']);
      const unknown = await client([`${pipeName}_desktop`, asPeer(child.pid, sid), 'open:view:no-such-room']);
      assert.deepEqual([unknown.byId.open.ok, unknown.byId.open.reply], [false, 'denied']);
      const again = await client([`${pipeName}_desktop`, asPeer(child.pid, sid), `open:view:${COMPUTER}`]);
      assert.deepEqual([again.byId.open.ok, again.byId.open.reply], [true, 'accepted']);
    });

    it('stops before sending when the server PID is not the Broker\'s', async () => {
      const run = await client([`${pipeName}_desktop`, asPeer(child.pid + 1, sid), `open:view:${COMPUTER}`]);
      assert.deepEqual([run.byId.connect.ok, run.byId.connect.result], [false, 'server_identity_mismatch']);
    });
  });

  // The lab's whole lease flow against the REAL Broker service loop, with the receipts made by the lab script's own functions (New-LabTaskStartReceipt: digest, DTO, signing) and sent by the
  // REAL pipe client helper through the client's `claim` step. The only stand-in is the key: the lab makes its authority inside the guest, here the key is a test key handed to the same
  // functions (CNG private blob, as the service lab does), because the Broker has to pin it before it starts. The VM does not exist, so an input that gets past every check ends in the
  // Broker's `desktop_unavailable` at the adapter, which is what the log shows (the lab's mouse request ends there for another reason, see the README).
  describe('the lease flow of the lab, with the lab\'s own receipts (real Broker service loop, real helper, no VM)', () => {
    const LAB_PROJECT = 'lab-project', LAB_TASK = 'Lab check: tap the Shift key once', OP1 = 'lab-bd-act-1', OP2 = 'lab-bd-act-2';
    const flowAuthority = createTestAuthority({ kid: 'lab-hv-authority-1' });
    const pipeName = unique('ALBERA_LabLease');
    let helper, brokerChild, session;
    const guestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lab-hyperv-rights-check.ps1');

    before(async () => {
      helper = await buildPipeClient(path.join(root, 'helper'));
      const file = path.join(root, 'lease.config.json');
      writeFileSync(file, JSON.stringify({
        pipeName, database: path.join(root, 'lease.sqlite'), authorityKeys: [flowAuthority.keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG,
        computers: [{ computerId: COMPUTER, vmId: '0123abcd-4567-89ab-cdef-000000000001' }],
      }));
      brokerChild = startProcess(loopExe, standInService('serve-loop', file), { stdin: true });
      running.add(brokerChild);
      await waitForLine(brokerChild, 'BROKER_READY');
      session = brokerSession({ helper, sid, pipeName, pid: brokerChild.pid, authority: flowAuthority });
    });
    after(() => { brokerChild?.stdin.end(); });

    /** The CNG ECCPRIVATE blob of the test key (BCRYPT_ECDSA_PRIVATE_P256_MAGIC, 32-byte X, Y, d), which the guest functions import to sign with. */
    const privateBlob = () => {
      const jwk = flowAuthority.privateJwk();
      const header = Buffer.alloc(8);
      header.writeUInt32LE(0x32534345, 0);
      header.writeUInt32LE(32, 4);
      return Buffer.concat([header, ...['x', 'y', 'd'].map((part) => Buffer.from(jwk[part], 'base64url'))]).toString('base64');
    };
    /** fence -> the lab script's New-LabTaskStartReceipt; returns the claim {receipt, signature, action} exactly as the lab would send it. */
    async function labClaim(operationId) {
      const fence = await session.fence(COMPUTER);
      assert.equal(fence.ok, true, JSON.stringify(fence));
      return runWithGuestFunctions(guestPath, ['New-LabTaskStartReceipt', 'Get-LabActionDigest', 'Write-LabDigestMap', 'Write-LabDigestString', 'Write-LabBigEndian', 'New-LabNonce'],
        `$key = [System.Security.Cryptography.CngKey]::Import([Convert]::FromBase64String($cases.blob), [System.Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob)
         $signer = New-Object System.Security.Cryptography.ECDsaCng($key)
         $signer.HashAlgorithm = [System.Security.Cryptography.CngAlgorithm]::Sha256
         $authority = @{ Kid = [string]$cases.kid; Signer = $signer }
         $claim = New-LabTaskStartReceipt $authority $cases.fence $cases.operationId $cases.projectId $cases.computerId $cases.task $cases.leaseId $cases.policyVersion
         ConvertTo-Json -InputObject $claim -Compress`,
        { blob: privateBlob(), kid: flowAuthority.kid, fence, operationId, projectId: LAB_PROJECT, computerId: COMPUTER, task: LAB_TASK, leaseId: LEASE_ID, policyVersion: POLICY_VERSION });
    }
    /** What the helper reads on stdin for a claim, the way the lab writes it (the Broker is told by owner SID and PID here, a stand-in process instead of a service). */
    const helperInput = (name, claim) => {
      const file = path.join(root, `${name}.stdin.json`);
      writeFileSync(file, JSON.stringify({ pipeName, ...claim, timeoutMs: 10_000, expect: { ownerSid: sid, pid: brokerChild.pid } }));
      return file;
    };
    const claimOptions = (file) => [`claim-exe=${helper}`, `claim-stdin=${file}`];
    const desktop = `${pipeName}_desktop`;
    const open = (operationId, generation) => `open:act:${COMPUTER}:${operationId}:${generation}`;
    const denyReasons = () => brokerChild.lines.filter((text) => text.startsWith('DESKTOP_DENY=')).map((text) => text.slice('DESKTOP_DENY='.length));

    it('walks the lab\'s checks in order: refused before a claim, claimed, opened, input past every check, wrong generation refused, ended by a second claim', async () => {
      const peer = asPeer(brokerChild.pid, sid);

      // bd_cp_act_before_claim_refused: the very open the claim is about to make good is refused while nothing is claimed.
      const before = await client([desktop, peer, open(OP1, 1)]);
      assert.deepEqual([before.byId.open.ok, before.byId.open.reply], [false, 'denied']);
      assert.equal(denyReasons().at(-1), 'lease_unknown');

      // bd_cp_task_start_claim: the lab's receipt, sent by the helper from inside the client, is recorded as a task.start claim.
      const first = await labClaim(OP1);
      const claimed = await client([desktop, peer, 'claim', ...claimOptions(helperInput('claim1', first))]);
      assert.deepEqual([claimed.byId.claim.ok, claimed.byId.claim.reply, claimed.byId.claim.state, claimed.byId.claim.action, claimed.byId.claim.replayed], [true, 'claimed', 'UNKNOWN', 'task.start', false]);
      assert.ok(brokerChild.lines.includes('LEASE=GRANTED'), 'the Broker made the lease');

      // bd_cp_act_open and bd_cp_act_input: the same open is accepted now, and the keyboard request is not refused by the Broker's own checks (the lease, the shape): it reaches the adapter.
      const act = await client([desktop, peer, open(OP1, 1), 'input:tap=16', 'input:move=100,100+down=1+up=1']);
      assert.deepEqual([act.byId.open.ok, act.byId.open.reply], [true, 'accepted']);
      assert.deepEqual([act.byId.input.ok, act.byId.input.reply], [false, 'denied'], 'no VM behind the room: the adapter is where it ends');
      assert.equal(denyReasons().at(-1), 'desktop_unavailable');
      assert.deepEqual([act.byId.input_2.skipped, act.byId.input_2.because], [true, 'input']);

      // bd_cp_act_wrong_generation_refused
      const wrong = await client([desktop, peer, open(OP1, 2)]);
      assert.deepEqual([wrong.byId.open.ok, wrong.byId.open.reply], [false, 'denied']);
      assert.equal(denyReasons().at(-1), 'lease_generation');

      // bd_cp_act_revoked_by_new_claim: the first session is open while the second claim is made by the same process; the Broker then ends the session with its denied frame.
      const second = await labClaim(OP2);
      const revoked = await client([desktop, peer, open(OP1, 1), 'claim', 'end:15000', ...claimOptions(helperInput('claim2', second))]);
      assert.deepEqual(revoked.lines.map((line) => [line.id, line.ok]), [['connect', true], ['open', true], ['claim', true], ['end', false]]);
      assert.deepEqual([revoked.byId.claim.reply, revoked.byId.claim.action, revoked.byId.end.reply], ['claimed', 'task.start', 'denied']);
      assert.equal(denyReasons().at(-1), 'lease_revoked');

      // The second lease is generation 2 and is the one the restart check opens; the first one is gone.
      const next = await client([desktop, peer, open(OP2, 2)]);
      assert.deepEqual([next.byId.open.ok, next.byId.open.reply], [true, 'accepted']);
      const old = await client([desktop, peer, open(OP1, 1)]);
      assert.deepEqual([old.byId.open.ok, old.byId.open.reply], [false, 'denied']);
    });
  });
});
