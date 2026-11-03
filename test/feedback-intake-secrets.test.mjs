import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { intakeSecrets } from '../scripts/feedback-intake-secrets.mjs';
import { pkcs8Der } from '../services/feedback-intake/src/github-app.mjs';

const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['scripts/feedback-intake-secrets.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
});

test('a PKCS#1 App key becomes a PKCS#8 secret the Worker can import, with a fresh hash key', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  assert.match(privateKey, /BEGIN RSA PRIVATE KEY/);
  const { secrets, fingerprint } = intakeSecrets({ pem: privateKey, appId: '123', installationId: '456' });
  assert.deepEqual(Object.keys(secrets), ['APP_ID', 'APP_INSTALLATION_ID', 'APP_PRIVATE_KEY', 'IP_HASH_KEY']);
  assert.match(secrets.APP_PRIVATE_KEY, /^-----BEGIN PRIVATE KEY-----/);
  assert.ok(pkcs8Der(secrets.APP_PRIVATE_KEY).length > 1000);
  assert.match(secrets.IP_HASH_KEY, /^[A-Za-z0-9_-]{43}$/);
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  assert.throws(() => intakeSecrets({ pem: privateKey, appId: 'x', installationId: '456' }), /app_id_or_installation_invalid/);
});

test('the command writes the file once, prints no key material, and refuses to overwrite', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'albera-fb-secrets-'));
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const pemPath = path.join(dir, 'app.pem');
    const out = path.join(dir, 'secrets.json');
    writeFileSync(pemPath, privateKey);
    const first = await run([pemPath, '1', '2', out]);
    assert.equal(first.code, 0, first.out);
    assert.ok(!first.out.includes('PRIVATE KEY'));
    assert.ok(!first.out.includes(JSON.parse(readFileSync(out, 'utf8')).IP_HASH_KEY));
    const second = await run([pemPath, '1', '2', out]);
    assert.equal(second.code, 1);
    assert.match(second.out, /failed: EEXIST/);

    // "-": the JSON only on standard output (for the pipe into wrangler), the note on standard error, no file written
    const piped = await run([pemPath, '1', '2', '-']);
    assert.equal(piped.code, 0, piped.stderr);
    assert.deepEqual(Object.keys(JSON.parse(piped.stdout)), ['APP_ID', 'APP_INSTALLATION_ID', 'APP_PRIVATE_KEY', 'IP_HASH_KEY']);
    assert.ok(!piped.stderr.includes('PRIVATE KEY'));
    assert.match(piped.stderr, /^prepared APP_ID, APP_INSTALLATION_ID, APP_PRIVATE_KEY, IP_HASH_KEY; App key fingerprint [0-9a-f]{16}\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
