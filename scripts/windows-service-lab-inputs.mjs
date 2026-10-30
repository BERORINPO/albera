// Writes the synthetic signed receipts the issue #23 lab run sends (run on the HOST, before the guest run; nothing here touches a service).
//   node scripts/windows-service-lab-inputs.mjs <output.json>
// r1 to r3 each get their own ephemeral test authority (scripts/issue-22-approval-authority-fixture.mjs), so each Broker run is started with
// the public key that belongs to the receipt it will see. Receipts live for 1 hour (the harness default of 2 minutes is too short for a VM run).
//   r1  positive path, restart/replay (the same receipt is sent twice)
//   r2  every attempt that must be refused BEFORE a byte is sent (wrong principals, squatters): it never reaches a Broker that could accept it
//   r3  the image-hash variant, against a second journal
//   r4a, r4b  two DIFFERENT receipts signed by ONE authority key (same publicKey), for the real service host: two consecutive requests to one
//             running Broker service, against a third journal
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeReceipt, signReceipt } from '../test/helpers/windows-broker-harness.mjs';

const output = process.argv[2];
if (!output) { console.error('usage: windows-service-lab-inputs.mjs <output.json>'); process.exit(64); }
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const inputs = {};
for (const name of ['r1', 'r2', 'r3']) {
  inputs[name] = signReceipt(makeReceipt(`lab23-${name}-op`, `lab23-${name}-approval`, `lab23-${name}-receipt`, { expiresAt }));
}
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
for (const name of ['r4a', 'r4b']) {
  const receipt = makeReceipt(`lab23-${name}-op`, `lab23-${name}-approval`, `lab23-${name}-receipt`, { expiresAt });
  const signature = sign('sha256', Buffer.from(receipt, 'base64'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  inputs[name] = { receipt, signature, publicKey: publicKeyB64 };
}
writeFileSync(output, `${JSON.stringify(inputs, null, 2)}\n`, 'utf8');
console.log(`wrote ${Object.keys(inputs).length} synthetic signed receipts`);
