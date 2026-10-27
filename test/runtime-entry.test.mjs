import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPrivateWindowsAcl } from '../src/runtime/windows-acl.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeEntry = path.join(repositoryRoot, 'src', 'runtime', 'entry.mjs');

function withTimeout(promise, timeoutMs, errorCode) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

test('Runtime CLI serves the loopback approval page without starting a provider', { timeout: 15_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.homedir(), 'albera-runtime-entry-'));
  const projectRoot = path.join(temporaryRoot, 'empty-project');
  const storageRoot = path.join(temporaryRoot, 'private-runtime-data');
  const journalPath = path.join(storageRoot, 'runtime.audit.jsonl');
  let child;
  let exitResult;
  let exit;
  t.after(async () => {
    if (child && !exitResult) {
      child.kill('SIGTERM');
      await withTimeout(exit, 2_000, 'runtime_cli_sigterm_timeout').catch(() => {});
    }
    if (child && !exitResult) {
      child.kill('SIGKILL');
      await withTimeout(exit, 2_000, 'runtime_cli_sigkill_timeout').catch(() => {});
    }
    if (child && !exitResult) throw new Error('runtime_cli_child_did_not_exit; test storage preserved');
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await mkdir(projectRoot, { mode: 0o700 });
  await mkdir(storageRoot, { mode: 0o700 });
  await assertPrivateWindowsAcl(projectRoot, { kind: 'directory' });
  await assertPrivateWindowsAcl(storageRoot, { kind: 'directory' });

  child = spawn(process.execPath, [
    runtimeEntry,
    '--root', projectRoot,
    '--journal', journalPath,
    '--port', '0',
  ], {
    cwd: repositoryRoot,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      exitResult = { code, signal };
      resolve(exitResult);
    });
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });

  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runtime_cli_start_timeout')), 8_000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    };
    const onData = (chunk) => {
      output = `${output}${chunk}`.slice(-4096);
      const match = output.match(/^ALBERA Runtime listening at (http:\/\/127\.0\.0\.1:\d+\/r\/[a-f\d]{32}\/)[\r]?$/m);
      if (match) {
        output = '';
        finish(resolve, match[1]);
      }
    };
    const onError = () => finish(reject, new Error('runtime_cli_spawn_failed'));
    const onExit = () => finish(reject, new Error(stderr || 'runtime_cli_exited_before_listen'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(/<main\b(?=[^>]*\bhidden\b)[^>]*>/.test(html), 'Runtime controls should be hidden before bootstrap');
  const css = await readFile(path.join(repositoryRoot, 'src', 'runtime', 'approval-ui', 'approval.css'), 'utf8');
  assert.match(css, /main\[hidden\]\s*\{\s*display:\s*none/s);

  child.kill('SIGTERM');
  const stopped = await withTimeout(exit, 3_000, 'runtime_cli_shutdown_timeout');
  if (process.platform === 'win32') assert.deepEqual(stopped, { code: null, signal: 'SIGTERM' });
  else assert.deepEqual(stopped, { code: 0, signal: null });
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1_000) }));
  assert.equal(await readFile(journalPath, 'utf8'), '');
  const sessionId = await readFile(`${journalPath}.session-id`, 'utf8');
  assert.match(sessionId, /^[a-f\d]{32}\n$/);
});
