import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openRuntimeAuditJournal } from '../src/runtime/audit-journal.mjs';
import { createRuntimeHost } from '../src/runtime/host.mjs';
import { loadOrCreateRuntimeSessionId } from '../src/runtime/session-identity.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Runtime host serves the loopback approval page without starting a provider', { timeout: 30_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.homedir(), 'albera-runtime-entry-'));
  const projectRoot = path.join(temporaryRoot, 'empty-project');
  const storageRoot = path.join(temporaryRoot, 'private-runtime-data');
  const journalPath = path.join(storageRoot, 'runtime.audit.jsonl');
  let runtime;
  let journal;
  let url;
  const aclChecks = [];
  t.after(async () => {
    if (runtime) await runtime.close();
    else await journal?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await mkdir(projectRoot, { mode: 0o700 });
  await mkdir(storageRoot, { mode: 0o700 });

  const verifyWindowsAcl = async (targetPath, options) => { aclChecks.push({ targetPath, kind: options.kind }); };
  journal = await openRuntimeAuditJournal(journalPath, { verifyWindowsAcl });
  const runtimeSessionId = await loadOrCreateRuntimeSessionId(journalPath, { verifyWindowsAcl });
  runtime = createRuntimeHost({ roots: [projectRoot], journal, hostOptions: { sessionId: runtimeSessionId } });
  const address = await runtime.listen(0);
  url = address.url;
  // This host integration uses an injected storage verifier to avoid hosted-runner PowerShell startup.
  // The CLI remains unchanged and always uses the real verifier; actual Windows DACL checks are tested separately.
  assert.ok(aclChecks.some((check) => check.targetPath === storageRoot && check.kind === 'directory'));

  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(/<main\b(?=[^>]*\bhidden\b)[^>]*>/.test(html), 'Runtime controls should be hidden before bootstrap');
  const css = await readFile(path.join(repositoryRoot, 'src', 'runtime', 'approval-ui', 'approval.css'), 'utf8');
  assert.match(css, /main\[hidden\]\s*\{\s*display:\s*none/s);

  const uncertain = await runtime.close();
  runtime = undefined;
  assert.deepEqual(uncertain, []);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1_000) }));
  assert.equal(await readFile(journalPath, 'utf8'), '');
  const sessionId = await readFile(`${journalPath}.session-id`, 'utf8');
  assert.match(sessionId, /^[a-f\d]{32}\n$/);
});
