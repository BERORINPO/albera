#!/usr/bin/env node
// Writes the intake Worker's secrets file for `wrangler secret bulk` (scripts/feedback-intake-deploy.ps1 runs it; docs/architecture/feedback-intake.md).
//   node scripts/feedback-intake-secrets.mjs <app.pem> <appId> <installationId> <out.json>
// The App key GitHub hands out is PKCS#1; the Worker's WebCrypto imports PKCS#8 only, so it is converted here, in memory. IP_HASH_KEY is 32 fresh random bytes.
// With "-" as the out path the JSON goes to standard output only (the deploy script pipes it into `wrangler secret bulk`, so no file exists at any time).
// An out file must not exist yet (exclusive create; mode 600 means nothing on Windows, where the user's TEMP folder ACL is the guard).
// Nothing secret goes to standard error: only the names and the key's fingerprint prefix.
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @returns {{ secrets: Record<string, string>, fingerprint: string }} fingerprint = first 16 hex of the SHA-256 of the public key (SPKI DER), safe to show */
export function intakeSecrets({ pem, appId, installationId, random = randomBytes }) {
  if (!/^\d{1,12}$/.test(String(appId)) || !/^\d{1,15}$/.test(String(installationId))) throw new Error('app_id_or_installation_invalid');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('app_key_not_rsa');
  const fingerprint = createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  return {
    secrets: {
      APP_ID: String(appId),
      APP_INSTALLATION_ID: String(installationId),
      APP_PRIVATE_KEY: key.export({ type: 'pkcs8', format: 'pem' }),
      IP_HASH_KEY: random(32).toString('base64url'),
    },
    fingerprint,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [pemPath, appId, installationId, out] = process.argv.slice(2);
  if (!pemPath || !out) {
    process.stderr.write('usage: node scripts/feedback-intake-secrets.mjs <app.pem> <appId> <installationId> <out.json | ->\n');
    process.exit(2);
  }
  try {
    const { secrets, fingerprint } = intakeSecrets({ pem: readFileSync(pemPath, 'utf8'), appId, installationId });
    // "-": the JSON goes to standard output only, for a pipe into `wrangler secret bulk` (no file on disk at all); the note goes to standard error
    if (out === '-') process.stdout.write(JSON.stringify(secrets));
    else writeFileSync(out, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 });
    process.stderr.write(`prepared ${Object.keys(secrets).join(', ')}; App key fingerprint ${fingerprint}\n`);
  } catch (error) {
    // the message of a key parse error never contains key bytes, but keep to codes anyway
    process.stderr.write(`failed: ${/^[a-z_]+$/.test(error?.message ?? '') ? error.message : error?.code ?? 'error'}\n`);
    process.exit(1);
  }
}
