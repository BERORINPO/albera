// Writes the synthetic inputs the issue #23 lab run needs (run on the HOST, before the guest run; nothing here touches a service).
//   node scripts/windows-service-lab-inputs.mjs <output.json>
// Receipt v2 cannot be signed ahead of time: a receipt names a challenge that the running Broker issues (`fence`), and lives at most 300 seconds. So the guest
// signs at run time, and this file carries what it needs:
//   authority  one test Approval Authority key: its kid, its SPKI (pinned in the Broker service config under `authorityKeys`), its private key as a CNG
//              ECCPRIVATE blob (Windows PowerShell 5.1 has no PKCS#8 import; ECDsaCng takes this blob), and the one action digest every lab receipt carries
//              (the lab action is always synthetic.noop on the same project and computer, so the digest is a constant the guest does not have to compute)
//   r2         a receipt that is NEVER sent to a Broker that could accept it (it names a made-up challenge): the checks that must be refused BEFORE a byte is
//              written (wrong principals, squatters) hand it to the helper, which refuses first
// The private key is a throw-away test key that exists only in this file and in the guest's memory.
import { writeFileSync } from 'node:fs';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { createTestAuthority, signedReceipt, PRODUCTION_ISSUER } from './issue-22-approval-authority-fixture.mjs';

const output = process.argv[2];
if (!output) { console.error('usage: windows-service-lab-inputs.mjs <output.json>'); process.exit(64); }

const PROJECT_ID = 'lab-project';
const COMPUTER_ID = 'lab-computer';
const ECDSA_PRIVATE_P256_MAGIC = 0x32534345; // "ECS2", BCRYPT_ECDSA_PRIVATE_P256_MAGIC

const authority = createTestAuthority({ kid: 'lab-authority-1' });
const jwk = authority.privateJwk();
const header = Buffer.alloc(8);
header.writeUInt32LE(ECDSA_PRIVATE_P256_MAGIC, 0);
header.writeUInt32LE(32, 4); // cbKey
const privateBlob = Buffer.concat([header, ...['x', 'y', 'd'].map((part) => Buffer.from(jwk[part], 'base64url'))]);
if (privateBlob.length !== 8 + 96) throw new Error('unexpected P-256 key size');

const inputs = {
  authority: {
    kid: authority.kid,
    issuer: PRODUCTION_ISSUER,
    spki: authority.spki,
    privateBlob: privateBlob.toString('base64'),
    projectId: PROJECT_ID,
    computerId: COMPUTER_ID,
    actionDigest: computeActionDigest('broker.operation', { action: 'synthetic.noop', projectId: PROJECT_ID, computerId: COMPUTER_ID, args: {} }),
  },
  r2: signedReceipt({ authority, fence: { brokerEpoch: 1, leaseGeneration: 7, brokerChallenge: 'AAAAAAAAAAAAAAAAAAAAAA' }, name: 'lab23-r2', projectId: PROJECT_ID, computerId: COMPUTER_ID }),
};
writeFileSync(output, `${JSON.stringify(inputs, null, 2)}\n`, 'utf8');
console.log('wrote the lab authority (kid, SPKI, CNG private blob, action digest) and one never-sent receipt');
