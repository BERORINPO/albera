import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  buildBroker, buildProbe, currentUserSid, getUnavailableReason, startBroker, startProcess, waitForExit, waitForLine, GENERATION,
} from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged: the live DACL of the real Broker's pipe. Service mode (issue #23) gives the configured Control Plane SID
// exactly one extra ACE with the 0x00120083 mask; the owner stays the Broker's own SID. Skipped without the .NET 10 SDK.
const CONTROL_PLANE_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555'; // virtual-account shaped, never resolvable here
const CONTROL_PLANE_MASK = 0x00120083;

/** Splits "O:<owner>D:(A;;<mask>;;;<sid>)..." into the owner SID and [{ type, mask, sid }]. */
function parseSddl(sddl) {
  const owner = /^O:([^D]+)D:/u.exec(sddl)?.[1];
  const aces = [...sddl.matchAll(/\(([A-Z]+);[^;]*;([^;]+);[^;]*;[^;]*;([^)]+)\)/gu)].map((m) => ({ type: m[1], mask: m[2], sid: m[3] }));
  return { owner, aces };
}
const maskOf = (ace) => Number(ace.mask); // SDDL prints a non-standard mask as 0x... hex

describe('Broker pipe DACL in service mode', { skip: getUnavailableReason() }, () => {
  let root, brokerExe, probeExe, self;
  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'albera-cp-ace-'));
    brokerExe = buildBroker(path.join(root, 'broker'));
    probeExe = buildProbe(path.join(root, 'probe'));
    self = currentUserSid();
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  /** Start the real Broker for `allowedSid`, read its live pipe security with the probe, let the Broker exit. */
  async function liveSecurity(allowedSid) {
    const pipe = `ALBERA_CpAce_${randomBytes(8).toString('hex')}`;
    const broker = startBroker(brokerExe, pipe, path.join(root, `${pipe}.sqlite`), 'AAAA', allowedSid, GENERATION);
    try {
      await waitForLine(broker, 'BROKER_READY');
      const reader = startProcess(probeExe, ['dacl', pipe]);
      const sddl = (await waitForLine(reader, /^SDDL=/u)).slice('SDDL='.length);
      await waitForExit(reader);
      await waitForExit(broker); // serves one connection; it hangs up without a request, so the Broker ends by itself (its exit code is not under test here)
      return parseSddl(sddl);
    } finally {
      if (broker.closeCode === undefined) { broker.kill(); await waitForExit(broker); }
    }
  }

  it('a Control Plane SID that is not the Broker gets exactly one ACE, 0x00120083, and the owner stays the Broker', async () => {
    const { owner, aces } = await liveSecurity(CONTROL_PLANE_SID);
    assert.equal(owner, self);
    assert.deepEqual(aces.map((ace) => ({ type: ace.type, sid: ace.sid })), [{ type: 'A', sid: self }, { type: 'A', sid: CONTROL_PLANE_SID }]);
    assert.equal(maskOf(aces[0]), 0x001f019f, 'the Broker keeps PipeAccessRights.FullControl (0x1f019f, which includes pipe-instance creation)');
    assert.equal(maskOf(aces[1]), CONTROL_PLANE_MASK);
    assert.equal(maskOf(aces[1]) & (0x4 | 0x40000000 | 0x10000000), 0, 'no FILE_APPEND_DATA / FILE_CREATE_PIPE_INSTANCE and no generic right');
  });

  it('the Broker\'s own SID as the Control Plane SID adds nothing (same-user proofs keep a one-ACE DACL)', async () => {
    const { aces } = await liveSecurity(self);
    assert.deepEqual(aces.map((ace) => ace.sid), [self]);
  });

  it('a malformed Control Plane SID adds nothing', async () => {
    const { aces } = await liveSecurity('not-a-sid');
    assert.deepEqual(aces.map((ace) => ace.sid), [self]);
  });
});
