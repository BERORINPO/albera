// Writes the synthetic inputs the issue #23 lab run needs (run on the HOST, before the guest run; nothing here touches a service).
//   node scripts/windows-service-lab-inputs.mjs <output.json>
// Receipt v2 cannot be signed ahead of time: a receipt names a challenge that the running Broker issues (`fence`), and lives at most 300 seconds. So the guest
// signs at run time, and this file carries what it needs:
//   authority  one test Approval Authority key: its kid, its SPKI (pinned in the Broker service config under `authorityKeys`), its private key as a CNG
//              ECCPRIVATE blob (Windows PowerShell 5.1 has no PKCS#8 import; ECDsaCng takes this blob), and the one action digest every lab receipt carries
//              (the lab action is always synthetic.noop on the same project and computer, so the digest is a constant the guest does not have to compute),
//              and the lease id and policy version: the guest writes them into the Broker service config AND into every receipt it signs
//   r2         a receipt that is NEVER sent to a Broker that could accept it (it names a made-up challenge): the checks that must be refused BEFORE a byte is
//              written (wrong principals, squatters) hand it to the helper, which refuses first
//   fixtures   journalV2: a version 2 journal (claims with request_digest, no fence tables, one recorded operation) as base64. The guest has no SQLite tool, so the
//              lab check that migrates an old-version journal under the real service identity writes these bytes to the journal path (issue #84)
// The private key is a throw-away test key that exists only in this file and in the guest's memory.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { createTestAuthority, signedReceipt, PRODUCTION_ISSUER, SYNTHETIC_LEASE_ID, SYNTHETIC_POLICY_VERSION } from './issue-22-approval-authority-fixture.mjs';

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

// The same version 2 shape the host tests use (test/runtime-windows-broker-journal.test.mjs): the CREATE text the Broker's migration accepts, user_version 2, one row.
const JOURNAL_V2_OPERATION_ID = 'lab84-v2-op';
function journalV2Base64() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'albera-lab-journal-'));
  try {
    const file = path.join(temp, 'journal.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL, request_digest TEXT CHECK(request_digest IS NULL OR length(request_digest) = 64));');
    db.exec('PRAGMA user_version = 2;');
    db.exec(`INSERT INTO claims VALUES ('${JOURNAL_V2_OPERATION_ID}', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', 'V2DIGEST', 7, 'UNKNOWN', '${'A'.repeat(64)}');`);
    db.close();
    return readFileSync(file).toString('base64');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function taskStartInputs() {
  const dto = { action: 'task.start', projectId: PROJECT_ID, computerId: COMPUTER_ID, args: { task: 'Open Notepad and type hello' } };
  const tampered = { ...dto, args: { task: 'Open Notepad and type hellO' } };
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return { actionDigest: computeActionDigest('guest.command', dto), action: encode(dto), tamperedAction: encode(tampered) };
}

const inputs = {
  fixtures: { journalV2: { operationId: JOURNAL_V2_OPERATION_ID, base64: journalV2Base64() } },
  authority: {
    kid: authority.kid,
    issuer: PRODUCTION_ISSUER,
    spki: authority.spki,
    privateBlob: privateBlob.toString('base64'),
    projectId: PROJECT_ID,
    computerId: COMPUTER_ID,
    leaseId: SYNTHETIC_LEASE_ID,
    policyVersion: SYNTHETIC_POLICY_VERSION,
    actionDigest: computeActionDigest('broker.operation', { action: 'synthetic.noop', projectId: PROJECT_ID, computerId: COMPUTER_ID, args: {} }),
  },
  // A1 (#115 follow-up): a task.start claim carries its action DTO (base64 JSON); the Broker recomputes the digest from it. `tamperedAction` differs by one character.
  taskStart: taskStartInputs(),
  r2: signedReceipt({ authority, fence: { brokerEpoch: 1, leaseGeneration: 7, brokerChallenge: 'AAAAAAAAAAAAAAAAAAAAAA' }, name: 'lab23-r2', projectId: PROJECT_ID, computerId: COMPUTER_ID }),
};
writeFileSync(output, `${JSON.stringify(inputs, null, 2)}\n`, 'utf8');
console.log('wrote the lab authority (kid, SPKI, CNG private blob, lease id, policy version, action digest), one never-sent receipt and the version 2 journal fixture');
