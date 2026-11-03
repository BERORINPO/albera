import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { runWithGuestFunctions } from './guest-functions.mjs';
import {
  buildBrokerWithTestSeams, buildServiceLab, createTestAuthority, currentUserSid, getUnavailableReason, makeTrustedTempDirectory, nodePipeOwnerSid,
  standInService, startProcess, waitForExit, waitForLine, GENERATION, LEASE_CONFIG,
} from '../helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged. The lab's client of the Broker's desktop pipe (`albera-lab-service-shim.exe desktop ...`, DesktopClient.cs), which the nested Hyper-V lab runs as the
// Control Plane and as another caller. Two halves: a scripted fake Broker made in Node (every reply the client must tell apart, including the ones the real Broker never sends: a bad PNG,
// a wrong size, a short frame, a wrong server), and the REAL Broker service loop (seam build, no VM: a capture ends in the fixed denied reply) for the wire format itself.
// What this cannot show: the success path against the real Broker (needs Hyper-V, that is the lab) and `service:<name>` identities (need an SCM service).
const DENIED = { ok: false, code: 'denied' };
const OPENED = { ok: true };
const COMPUTER = 'lab-room';
const FOREIGN_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555';

const frame = (body) => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const size = Buffer.alloc(4);
  size.writeInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
};

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, tail]);
};
/** An 8-bit truecolour PNG, the shape the Broker's encoder makes (signature, IHDR, IDAT, IEND). `brokenEnd` damages the last byte of IEND. */
function png(width, height, { brokenEnd = false } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
  if (brokenEnd) bytes[bytes.length - 1] ^= 0xff;
  return bytes;
}

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
    const pipe = unique('ALBERA_LabDesk');
    const state = { pipe, received: [], bytes: 0, connections: 0 };
    const server = net.createServer((socket) => {
      state.connections += 1;
      let buffer = Buffer.alloc(0);
      let index = 0;
      const connection = { send: (body) => socket.write(frame(body)), sendRaw: (bytes) => socket.write(bytes), end: () => socket.end() };
      socket.on('error', () => {});
      socket.on('data', (chunkBytes) => {
        state.bytes += chunkBytes.length;
        buffer = Buffer.concat([buffer, chunkBytes]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
          const length = buffer.readInt32LE(0);
          const body = buffer.subarray(4, 4 + length).toString('utf8');
          buffer = buffer.subarray(4 + length);
          state.received.push(body);
          script(body, index, connection);
          index += 1;
        }
      });
    });
    servers.add(server);
    await new Promise((resolve) => server.listen(`\\\\.\\pipe\\${pipe}`, resolve));
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
      for (const args of [['open:edit:x'], ['open:view'], ['open:view:bad id'], ['capture:640'], ['capture:0x480'], ['capture:axb'], ['input:x'], [], ['save=x']]) {
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
  });

  describe('the config the lab writes for the Broker', () => {
    it('is accepted by the real Broker\'s config check (inner VM as the one computer, lowercase GUID, a well-formed pinned key), and the desktop pipe name follows the Broker\'s rule', () => {
      const guestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lab-hyperv-rights-check.ps1');
      const guestText = readFileSync(guestPath, 'utf8');
      const constant = (name) => new RegExp(`^\\$${name} = '([^']+)'`, 'mu').exec(guestText)[1];
      const written = path.join(root, 'lab-written.config.json');
      const vmId = '0123ABCD-4567-89AB-CDEF-000000000002';   // as Get-VM prints it; the lab lowercases it
      // Write-BdBrokerConfig reads the script-level names of the lab script, so they are taken from its text and handed over, never copied into this test.
      runWithGuestFunctions(guestPath, ['Write-BdBrokerConfig', 'New-LabSpki'],
        `$BdPipe = $cases.pipe; $BdComputerId = $cases.computerId; Write-BdBrokerConfig $cases.path $cases.database $cases.cpSid $cases.vmId; Write-Output '{}'`,
        { pipe: constant('BdPipe'), computerId: constant('BdComputerId'), path: written, database: path.join(root, 'lab-written.sqlite'), cpSid: FOREIGN_SID, vmId });
      const config = JSON.parse(readFileSync(written, 'utf8'));
      assert.deepEqual(config.computers, [{ computerId: constant('BdComputerId'), vmId: vmId.toLowerCase() }]);
      assert.equal(config.controlPlaneSid, FOREIGN_SID);
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
});
