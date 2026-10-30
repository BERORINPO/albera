import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { sendBrokerRequest } from '../src/runtime/windows-broker-client.mjs';
import {
  buildBroker, buildPipeClient, buildServiceLab, currentUserSid, getUnavailableReason, inspectClaimCount, makeReceipt, signReceipt,
  startProcess, waitForExit, GENERATION,
} from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged, no service and no SCM: the issue #23 lab tool (test/windows-service-lab) run through its `run` entry point
// and its probes, so the guest run starts from code that already works. The SCM entry (`service`) can only run in the lab VM.
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const MISMATCH = { ok: false, code: 'server_identity_mismatch' };
const FOREIGN_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555';

describe('issue #23 lab tool: shim jobs and probes, host side', { skip: getUnavailableReason() }, () => {
  let root, shim, brokerExe, brokerDll, helper, sid;
  const running = new Set();
  before(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'albera-service-lab-'));
    shim = buildServiceLab(path.join(root, 'shim'));
    brokerExe = buildBroker(path.join(root, 'broker'));
    brokerDll = path.join(root, 'broker', 'albera-windows-broker.dll');
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
  });
  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const pipeName = () => `ALBERA_Lab_${randomBytes(8).toString('hex')}`;
  const track = (child) => { running.add(child); child.once('close', () => running.delete(child)); return child; };
  const result = (name) => path.join(root, `${name}.result.txt`);
  const resultLines = (name) => (existsSync(result(name)) ? readFileSync(result(name), 'utf8').split(/\r?\n/u).filter(Boolean) : []);
  const jsonLines = (lines) => lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  const probe = (...args) => JSON.parse(execFileSync(shim, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true }));

  /** Write a job config and start `shim run <config>`; returns the process (its `run` exit code is the job's). */
  function startJob(name, job) {
    const config = path.join(root, `${name}.config.json`);
    writeFileSync(config, JSON.stringify({ resultFile: result(name), ...job }));
    return track(startProcess(shim, ['run', config]));
  }
  async function waitForResult(name, pattern) {
    for (let i = 0; i < 150; i += 1) {
      if (resultLines(name).some((line) => pattern.test(line))) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`timeout ${pattern}: ${resultLines(name).join('|')}`);
  }
  const brokerJob = (mode, pipe, db, signed, extra = {}) => ({ mode, program: mode === 'inproc' ? brokerDll : brokerExe, args: ['serve', pipe, db, signed.publicKey, extra.allowedSid ?? sid, String(GENERATION), 'normal'] });
  const send = (pipe, signed, expect) => sendBrokerRequest({ pipeName: pipe, receipt: signed.receipt, signature: signed.signature, expect, helperPath: helper, timeoutMs: 10_000 });

  it('child mode runs a command as the service account and records its stdout, exit code and own token', async () => {
    const tokenFile = path.join(root, 'child.token.json');
    const job = startJob('child', { mode: 'child', program: shim, args: ['token'], tokenFile });
    assert.equal(await waitForExit(job), 0);
    const lines = resultLines('child');
    assert.ok(lines[0].startsWith('[shim] start ') && lines.at(-1) === '[shim] exit=0', lines.join('|'));
    const [token] = jsonLines(lines);
    assert.equal(token.user.sid, sid);
    assert.equal(JSON.parse(readFileSync(tokenFile, 'utf8')).user.sid, sid);
    assert.equal(typeof token.sessionId, 'number');
    assert.deepEqual(token.restrictedSids, [], 'an ordinary token has no restricting SIDs');
    assert.ok(token.groups.some((g) => g.attributes.includes('enabled')) && Array.isArray(token.privileges) && token.integritySid.startsWith('S-1-16-'));
  });

  it('child mode feeds a stdin file and times out a command that does not end', async () => {
    const stdinFile = path.join(root, 'stdin.json');
    writeFileSync(stdinFile, '{"pipeName":"ALBERA_Lab_None","receipt":"AAAA","signature":"AAAA","timeoutMs":1000,"expect":{"ownerSid":"S-1-5-18","pid":1}}\n');
    const missing = startJob('stdin', { mode: 'child', program: helper, stdinFile });
    assert.equal(await waitForExit(missing), 0);
    assert.deepEqual(jsonLines(resultLines('stdin')), [{ ok: false, code: 'broker_unavailable' }]);
    const slow = startJob('timeout', { mode: 'child', program: shim, args: ['squat', pipeName(), '30'], timeoutSeconds: 1 });
    assert.ok([-2, 0xfffffffe].includes(await waitForExit(slow)), 'exit code -2 (timeout)');
    assert.ok(resultLines('timeout').includes('[shim] timeout; killing the child'));
  });

  it('inproc mode hosts the real Broker in the shim process, so the pipe server PID is the host PID (what SCM reports for a service)', async () => {
    const db = path.join(root, 'inproc.sqlite'), pipe = pipeName();
    const signed = signReceipt(makeReceipt('lab-inproc-op', 'lab-inproc-approval', 'lab-inproc-receipt'));
    const job = startJob('inproc', brokerJob('inproc', pipe, db, signed));
    await waitForResult('inproc', /^BROKER_READY$/u);
    assert.deepEqual(await send(pipe, signed, { ownerSid: sid, pid: job.pid }), SUCCESS);
    assert.equal(await waitForExit(job), 0);
    assert.ok(resultLines('inproc').includes('CLAIM=PERSISTED_UNKNOWN'), resultLines('inproc').join('|'));
    assert.equal(inspectClaimCount(brokerExe, db), 1);
  });

  it('child mode launches the Broker as a child: the pipe server PID is the child, NOT the shim (so a launcher cannot be the SCM service process)', async () => {
    const db = path.join(root, 'child-broker.sqlite');
    const signed = signReceipt(makeReceipt('lab-child-op', 'lab-child-approval', 'lab-child-receipt'));
    const wrongPipe = pipeName(), rightPipe = pipeName();
    const launcher = startJob('child-wrong', brokerJob('child', wrongPipe, db, signed));
    await waitForResult('child-wrong', /^BROKER_READY$/u);
    assert.deepEqual(await send(wrongPipe, signed, { ownerSid: sid, pid: launcher.pid }), MISMATCH, 'the launcher PID is not the pipe server');
    await waitForExit(launcher);
    assert.equal(inspectClaimCount(brokerExe, db), 0);
    const right = startJob('child-right', brokerJob('child', rightPipe, db, signed));
    await waitForResult('child-right', /^BROKER_READY$/u);
    const childPid = Number(resultLines('child-right').find((line) => line.startsWith('[shim] child pid='))?.split('=')[1]);
    assert.deepEqual(await send(rightPipe, signed, { ownerSid: sid, pid: childPid }), SUCCESS);
    await waitForExit(right);
    assert.equal(inspectClaimCount(brokerExe, db), 1);
  });

  it('squat probe: the helper refuses a first-instance squatter on owner mismatch and the squatter receives 0 bytes', async () => {
    const pipe = pipeName();
    const signed = signReceipt(makeReceipt('lab-squat-op', 'lab-squat-approval', 'lab-squat-receipt'));
    const squatter = track(startProcess(shim, ['squat', pipe, '10']));
    for (let i = 0; i < 100 && !squatter.lines.some((line) => line.includes('"ready"')); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const ready = jsonLines(squatter.lines)[0];
    assert.equal(ready.state, 'ready');
    assert.deepEqual(await send(pipe, signed, { ownerSid: FOREIGN_SID, pid: ready.pid }), MISMATCH);
    await waitForExit(squatter);
    assert.deepEqual(jsonLines(squatter.lines).at(-1), { probe: 'squat', state: 'done', connected: true, bytesReceived: 0 });
  });

  it('pipe-open probe reports the live owner, DACL, server PID and session of the real Broker pipe', async () => {
    const db = path.join(root, 'pipe-open.sqlite'), pipe = pipeName();
    const signed = signReceipt(makeReceipt('lab-open-op', 'lab-open-approval', 'lab-open-receipt'));
    const job = startJob('pipe-open', brokerJob('inproc', pipe, db, signed, { allowedSid: FOREIGN_SID }));
    await waitForResult('pipe-open', /^BROKER_READY$/u);
    const opened = probe('pipe-open', pipe, '00120083');
    assert.equal(opened.result, 'opened');
    assert.equal(opened.owner, sid);
    assert.equal(opened.serverPid, job.pid);
    assert.match(opened.sddl, new RegExp(`\\(A;;0x120083;;;${FOREIGN_SID}\\)`, 'u'));
    await waitForExit(job);
  });

  it('scm and openproc probes report fixed JSON; a missing service is never opened and the image hash matches', async () => {
    const scm = probe('scm', 'AlberaLabNoSuchService');
    assert.equal(scm.probe, 'scm');
    assert.equal(Object.values(scm.openService ?? {}).includes('opened'), false);
    const proc = probe('openproc', String(process.pid));
    assert.equal(proc.openProcess.PROCESS_QUERY_LIMITED_INFORMATION, 'opened');
    assert.equal(proc.imageSha256, (await captureExecutableIdentity(process.execPath)).sha256);
  });

  it('token-of probe reports another process\'s token (the lab reads the real Broker service this way) or the Win32 error', () => {
    const own = probe('token-of', String(process.pid));
    assert.equal(own.pid, process.pid);
    assert.equal(own.user.sid, sid);
    assert.deepEqual(own.restrictedSids, []);
    assert.deepEqual(probe('token-of', '999999999'), { probe: 'token-of', pid: 999999999, result: 'error_87' });
  });
});
