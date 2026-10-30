// Writes the synthetic signed receipts the issue #23 lab run sends (run on the HOST, before the guest run; nothing here touches a service).
//   node scripts/windows-service-lab-inputs.mjs <output.json>
// Each receipt gets its own ephemeral test authority (scripts/issue-22-approval-authority-fixture.mjs), so each Broker run is started with
// the public key that belongs to the receipt it will see. Receipts live for 1 hour (the harness default of 2 minutes is too short for a VM run).
//   r1  positive path, restart/replay (the same receipt is sent twice)
//   r2  every attempt that must be refused BEFORE a byte is sent (wrong principals, squatters): it never reaches a Broker that could accept it
//   r3  the image-hash variant, against a second journal
import { writeFileSync } from 'node:fs';
import { makeReceipt, signReceipt } from '../test/helpers/windows-broker-harness.mjs';

const output = process.argv[2];
if (!output) { console.error('usage: windows-service-lab-inputs.mjs <output.json>'); process.exit(64); }
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const inputs = {};
for (const name of ['r1', 'r2', 'r3']) {
  inputs[name] = signReceipt(makeReceipt(`lab23-${name}-op`, `lab23-${name}-approval`, `lab23-${name}-receipt`, { expiresAt }));
}
writeFileSync(output, `${JSON.stringify(inputs, null, 2)}\n`, 'utf8');
console.log(`wrote ${Object.keys(inputs).length} synthetic signed receipts`);
