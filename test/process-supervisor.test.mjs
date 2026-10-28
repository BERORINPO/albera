import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { spawnSupervised } from '../src/runtime/supervisor.mjs';

const supervisorUrl = pathToFileURL(path.resolve('src/runtime/supervisor.mjs')).href;
const gatewayUrl = pathToFileURL(path.resolve('src/runtime/gateway.mjs')).href;

test('supervised child rejects provider input after a stop request', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-input-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'home', 'tmpdir'].includes(key.toLowerCase())));
  const child = spawnSupervised(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], {
    cwd: root, env, inputMode: 'claude-stream-json', initialInput: 'synthetic initial input',
  });
  const started = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  await started;
  assert.deepEqual(await child.stopTree('SIGTERM'), { treeConfirmed: true });
  await assert.rejects(child.writeInput('must not be queued after stop'), (error) => error.message === 'input_unavailable');
  await closed;
});

test('local process guardian reaps its provider tree when the Gateway host crashes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-guardian-'));
  const marker = path.join(root, 'heartbeat.txt');
  const nonce = path.basename(root);
  const helperCode = `import fs from 'node:fs';const p=process.argv[1],n=${JSON.stringify(nonce)};process.on('SIGTERM',()=>{});fs.appendFileSync(p,n+'\\n');setInterval(()=>fs.appendFileSync(p,n+'\\n'),40);`;
  const hostCode = `import { RuntimeGateway } from ${JSON.stringify(gatewayUrl)};import { spawnSupervised } from ${JSON.stringify(supervisorUrl)};const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['path','systemroot','windir','temp','tmp','userprofile','home','tmpdir'].includes(k.toLowerCase())));const gateway=new RuntimeGateway({roots:[${JSON.stringify(root)}],authorize:async()=>true,resolveExecutableImpl:async()=>process.execPath,buildLaunchImpl:(_p,profile,args)=>({profile,args}),env,spawnImpl:(exe,args,options)=>{const child=spawnSupervised(exe,args,options);child.once('error',()=>process.stdout.write(JSON.stringify({failure:true})+'\\n'));child.once('spawn',()=>process.stdout.write(JSON.stringify({pid:child.pid})+'\\n'));return child;}});await gateway.start({provider:'claude',cwd:${JSON.stringify(root)},prompt:['-e',${JSON.stringify(helperCode)},${JSON.stringify(marker)}]});setInterval(()=>{},1000);`;
  const host = spawn(process.execPath, ['--input-type=module', '-e', hostCode], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let providerPid;
  let hostClosed = false;
  const cleanup = async () => {
    if (!hostClosed) host.kill('SIGKILL');
    if (Number.isInteger(providerPid)) {
      try {
        const before = await stat(marker);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const after = await stat(marker);
        if (after.size > before.size) process.kill(providerPid, 'SIGKILL');
      } catch { /* child is already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  };
  t.after(cleanup);

  let output = '';
  const ready = new Promise((resolve, reject) => {
    host.stdout.setEncoding('utf8');
    host.stdout.on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      try {
        const message = JSON.parse(output.slice(0, newline));
        if (message.failure) return reject(new Error('guardian_failed_before_provider_start'));
        providerPid = message.pid;
        resolve();
      }
      catch (error) { reject(error); }
    });
    host.once('error', reject);
    host.once('close', () => { hostClosed = true; if (!Number.isInteger(providerPid)) reject(new Error('supervised_provider_did_not_start')); });
  });
  let timeout;
  // Full executable hashing runs before approval; allow slower CI hosts to finish it.
  try { await Promise.race([ready, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('supervised_provider_start_timeout')), 30_000); })]); }
  finally { clearTimeout(timeout); }
  let beforeCrash;
  const heartbeatDeadline = Date.now() + 5000;
  while (Date.now() < heartbeatDeadline) {
    try { beforeCrash = await readFile(marker, 'utf8'); } catch { beforeCrash = ''; }
    if (beforeCrash.split('\n').filter(Boolean).length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(beforeCrash.split('\n').filter(Boolean).length >= 2, 'local helper must show a live heartbeat before the Gateway crash');

  host.kill('SIGKILL');
  await new Promise((resolve) => host.once('close', () => { hostClosed = true; resolve(); }));
  await new Promise((resolve) => setTimeout(resolve, 900));
  const afterCrash = await readFile(marker, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 180));
  const afterSettle = await readFile(marker, 'utf8');
  assert.equal(afterSettle, afterCrash, 'guardian must stop the local helper after its parent disappears');
});
