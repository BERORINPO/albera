import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { spawnSupervised } from '../src/runtime/supervisor.mjs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const enabled = process.platform === 'win32' && process.arch === 'x64';
const guardian = path.resolve('src/runtime/windows-job-guardian/bin/Release/net10.0-windows/win-x64/publish/albera-windows-job-guardian.exe');
const breakawayProbe = path.resolve('test/windows-job-probe/bin/Release/net10.0-windows/albera-windows-job-probe.exe');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'home', 'tmpdir'].includes(key.toLowerCase())));

test('Windows Job Guardian integration tests require the Windows build artifact', { skip: !enabled }, async (t) => {
  await access(guardian);
  await access(breakawayProbe);

  await t.test('stop confirms child and grandchild exit only after the Job is drained', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'albera-job-tree-'));
    const marker = path.join(root, 'heartbeats.txt');
    t.after(() => cleanup(root, child));
    const grandCode = `const fs=require('node:fs');const p=${JSON.stringify(marker)};setInterval(()=>fs.appendFileSync(p,'grand\\n'),20);`;
    const childCode = `const fs=require('node:fs');const {spawn}=require('node:child_process');const p=${JSON.stringify(marker)};spawn(process.execPath,['--input-type=commonjs','-e',${JSON.stringify(grandCode)}],{stdio:'ignore'});setInterval(()=>fs.appendFileSync(p,'child\\n'),20);`;
    const rootCode = `const fs=require('node:fs');const {spawn}=require('node:child_process');const p=${JSON.stringify(marker)};spawn(process.execPath,['--input-type=commonjs','-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>fs.appendFileSync(p,'root\\n'),20);`;
    const child = spawnSupervised(process.execPath, ['--input-type=commonjs', '-e', rootCode], { cwd: root, env });
    const started = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const closed = new Promise((resolve) => child.once('close', resolve));
    await started;
    await waitFor(async () => (await readFile(marker, 'utf8').catch(() => '')).includes('grand\n'));
    assert.deepEqual(await child.stopTree('SIGTERM'), { treeConfirmed: true });
    await closed;
    assert.equal(child.treeStopConfirmed, true);
    const afterStop = await readFile(marker, 'utf8');
    await delay(160);
    assert.equal(await readFile(marker, 'utf8'), afterStop, 'no managed descendant writes after the Job reports zero active processes');
  });

  await t.test('root exit with a live descendant drains the Job before reporting exit', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'albera-job-root-exit-'));
    const marker = path.join(root, 'heartbeats.txt');
    t.after(() => cleanup(root, child));
    const childCode = `const fs=require('node:fs');const p=${JSON.stringify(marker)};fs.writeFileSync(p,'child-ready\\n');setInterval(()=>fs.appendFileSync(p,'child\\n'),20);`;
    const rootCode = `const fs=require('node:fs');const {spawn}=require('node:child_process');const p=${JSON.stringify(marker)};spawn(process.execPath,['--input-type=commonjs','-e',${JSON.stringify(childCode)}],{stdio:'ignore'});const deadline=Date.now()+2000;const wait=()=>fs.existsSync(p)?process.exit(0):Date.now()>deadline?process.exit(4):setTimeout(wait,10);wait();`;
    const child = spawnSupervised(process.execPath, ['--input-type=commonjs', '-e', rootCode], { cwd: root, env });
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    await withTimeout(closed, 7000, 'root_exit_close_timeout');
    assert.equal(child.exitCode, 0);
    assert.equal(child.treeStopConfirmed, true);
    const afterExit = await readFile(marker, 'utf8');
    await delay(120);
    assert.equal(await readFile(marker, 'utf8'), afterExit);
  });

  await t.test('breakaway creation is denied by the Job Object policy', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'albera-job-breakaway-'));
    const marker = path.join(root, 'escaped.txt');
    t.after(() => cleanup(root, child));
    const child = spawnSupervised(breakawayProbe, ['breakaway', marker], { cwd: root, env });
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    await withTimeout(closed, 7000, 'breakaway_close_timeout');
    assert.equal(child.exitCode, 0, 'probe exits zero only when CREATE_BREAKAWAY_FROM_JOB is denied with ERROR_ACCESS_DENIED');
    assert.equal(child.treeStopConfirmed, true);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  });

  await t.test('guardian process loss reaps its Job on handle close but reports termination as unknown', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'albera-job-owner-loss-'));
    const marker = path.join(root, 'heartbeats.txt');
    let ownerProcess;
    t.after(async () => {
      if (ownerProcess && ownerProcess.exitCode === null) ownerProcess.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    });
    const script = `const fs=require('node:fs');const p=${JSON.stringify(marker)};setInterval(()=>fs.appendFileSync(p,'alive\\n'),20);`;
    const helper = ownerProcess = spawn(guardian, [], { cwd: root, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk) => { output += chunk; });
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owner_loss_start_timeout')), 7000);
      const check = () => {
        const line = output.split('\n').find((entry) => entry.includes('"type":"started"'));
        if (!line) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      };
      helper.stdout.on('data', check);
      helper.once('error', reject);
    });
    helper.stdin.write(`${JSON.stringify({ type: 'launch', executable: process.execPath,
      args: ['--input-type=commonjs', '-e', script], cwd: root, env })}\n`);
    await started;
    await waitFor(async () => (await readFile(marker, 'utf8').catch(() => '')).length > 0);
    const closed = new Promise((resolve) => helper.once('close', resolve));
    helper.kill('SIGKILL');
    await withTimeout(closed, 7000, 'owner_loss_close_timeout');
    assert.equal(output.includes('"type":"tree_stop"'), false);
    assert.equal(output.includes('"type":"exit"'), false, 'lost owner cannot return OS-observed Job drain evidence');
    const afterOwnerLoss = await readFile(marker, 'utf8');
    await delay(120);
    assert.equal(await readFile(marker, 'utf8'), afterOwnerLoss, 'KILL_ON_JOB_CLOSE provides cleanup after guardian loss');
  });
});

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error('synthetic_process_condition_timeout');
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function cleanup(root, child) {
  if (child && child.closed !== true) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
