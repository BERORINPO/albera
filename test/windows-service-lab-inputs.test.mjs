import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { validateReceiptV2 } from '../src/runtime/broker-contract/receipt-v2.mjs';

// The VM lab signs receipt v2 inside the guest (Windows PowerShell 5.1, ECDsaCng, a CNG private blob) from scripts/windows-service-lab-inputs.mjs.
// The lab itself cannot run here; these tests run what can: the inputs file on any OS, and the guest's receipt functions under the host's Windows PowerShell.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BROKER_EXPECTED = { audience: 'albera-host-broker', purpose: 'broker.operation' };
const FENCE = { ok: true, brokerEpoch: 3, leaseGeneration: 7, brokerChallenge: 'AAAAAAAAAAAAAAAAAAAAAA' };

describe('lab inputs for receipt v2', () => {
  let temp, inputs;
  before(() => {
    temp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-lab-inputs-')));
    const file = path.join(temp, 'lab-inputs.json');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'windows-service-lab-inputs.mjs'), file], { stdio: 'pipe', timeout: 30_000, windowsHide: true });
    inputs = JSON.parse(readFileSync(file, 'utf8'));
  });
  after(() => rmSync(temp, { recursive: true, force: true }));

  const contextFor = (receiptBytes, overrides = {}) => {
    const receipt = JSON.parse(receiptBytes);
    return {
      clock: () => Math.floor(Date.now() / 1000), environment: 'production',
      expected: { ...BROKER_EXPECTED, leaseId: inputs.authority.leaseId, policyVersion: inputs.authority.policyVersion, operationId: receipt.operationId, idempotencyKey: receipt.idempotencyKey, leaseGeneration: FENCE.leaseGeneration, brokerEpoch: FENCE.brokerEpoch, brokerChallenge: FENCE.brokerChallenge, ...overrides },
      action: { action: 'synthetic.noop', projectId: inputs.authority.projectId, computerId: inputs.authority.computerId, args: {} },
    };
  };

  it('carries a version 2 journal fixture (issue #84) that the Broker\'s migration accepts: user_version 2, the exact claims CREATE text, one recorded operation', () => {
    const { operationId, base64 } = inputs.fixtures.journalV2;
    const file = path.join(temp, 'fixture-journal.sqlite');
    writeFileSync(file, Buffer.from(base64, 'base64'));
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.deepEqual(db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all().map((row) => ({ ...row })), [
        { type: 'table', name: 'claims', sql: 'CREATE TABLE claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL, request_digest TEXT CHECK(request_digest IS NULL OR length(request_digest) = 64))' },
      ], 'no other object, and the text src/runtime/windows-broker/Journal.cs compares against');
      assert.deepEqual(db.prepare('SELECT operation_id, state, length(request_digest) AS digest_length FROM claims').all().map((row) => ({ ...row })), [{ operation_id: operationId, state: 'UNKNOWN', digest_length: 64 }]);
    } finally { db.close(); }
    assert.equal(operationId, 'lab84-v2-op');
  });

  it('carries exactly the fixtures, the authority, the task.start DTOs and one never-sent receipt, and the CNG private blob is the same key as the pinned SPKI', () => {
    assert.deepEqual(Object.keys(inputs).sort(), ['authority', 'fixtures', 'r2', 'taskStart']);
    assert.deepEqual(Object.keys(inputs.authority).sort(), ['actionDigest', 'computerId', 'issuer', 'kid', 'leaseId', 'policyVersion', 'privateBlob', 'projectId', 'spki']);
    const blob = Buffer.from(inputs.authority.privateBlob, 'base64');
    assert.equal(blob.length, 104);
    assert.equal(blob.readUInt32LE(0), 0x32534345, 'BCRYPT_ECDSA_PRIVATE_P256_MAGIC');
    assert.equal(blob.readUInt32LE(4), 32);
    const privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: blob.subarray(8, 40).toString('base64url'), y: blob.subarray(40, 72).toString('base64url'), d: blob.subarray(72, 104).toString('base64url') }, format: 'jwk' });
    const publicKey = createPublicKey({ key: Buffer.from(inputs.authority.spki, 'base64'), format: 'der', type: 'spki' });
    assert.ok(verify('sha256', Buffer.from('x'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sign('sha256', Buffer.from('x'), { key: privateKey, dsaEncoding: 'ieee-p1363' })));
  });

  it('the action digest in the inputs is the contract\'s digest of the lab\'s fixed action, and r2 is a valid signed v2 receipt', () => {
    assert.equal(inputs.authority.actionDigest, computeActionDigest('broker.operation', { action: 'synthetic.noop', projectId: inputs.authority.projectId, computerId: inputs.authority.computerId, args: {} }));
    const bytes = Buffer.from(inputs.r2.receipt, 'base64');
    const publicKey = createPublicKey({ key: Buffer.from(inputs.authority.spki, 'base64'), format: 'der', type: 'spki' });
    assert.ok(verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(inputs.r2.signature, 'base64')));
    const receipt = JSON.parse(bytes);
    assert.equal(receipt.kid, inputs.authority.kid);
    assert.equal(validateReceiptV2(bytes, contextFor(bytes, { brokerEpoch: 1 })).ok, true, 'r2 names epoch 1 and a made-up challenge');
  });

  it('taskStart: the digest is the contract digest of the decoded guest.command DTO, and the tampered DTO is one character off with a different digest', () => {
    assert.deepEqual(Object.keys(inputs.taskStart).sort(), ['action', 'actionDigest', 'tamperedAction']);
    const dto = JSON.parse(Buffer.from(inputs.taskStart.action, 'base64').toString('utf8'));
    const tampered = JSON.parse(Buffer.from(inputs.taskStart.tamperedAction, 'base64').toString('utf8'));
    assert.deepEqual(Object.keys(dto.args), ['task']);
    assert.equal(dto.action, 'task.start');
    assert.equal(dto.computerId, inputs.authority.computerId);
    assert.equal(inputs.taskStart.actionDigest, computeActionDigest('guest.command', dto));
    assert.notEqual(computeActionDigest('guest.command', tampered), inputs.taskStart.actionDigest);
    assert.equal([...dto.args.task].filter((ch, i) => ch !== tampered.args.task[i]).length, 1);
  });

  it('lab-guest.ps1 parses under Windows PowerShell 5.1 with no syntax error (the VM run is the lead\'s, so this is the only check of the script text here)', { skip: process.platform !== 'win32' && 'Windows PowerShell only' }, () => {
    const script = path.join(temp, 'parse-check.ps1');
    writeFileSync(script, [
      'param([string]$File)',
      '$errors = $null; $tokens = $null',
      '[void][System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$tokens, [ref]$errors)',
      "if ($errors) { $errors | ForEach-Object { $_.ToString() }; exit 1 }",
      '[scriptblock]::Create((Get-Content -Raw $File)) | Out-Null',
    ].join('\r\n'));
    const guest = path.join(root, 'test', 'windows-service-lab', 'lab-guest.ps1');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-File', guest], { stdio: 'pipe', timeout: 60_000, windowsHide: true });
  });

  it('the guest\'s signing functions run under Windows PowerShell 5.1: the receipt they build passes the contract and the signature verifies against the pinned SPKI', { skip: process.platform !== 'win32' && 'Windows PowerShell only' }, () => {
    const script = path.join(temp, 'sign-check.ps1');
    // Pull the receipt functions out of lab-guest.ps1 (between New-LabNonce and the fenced-claim helper) so the file under test is the one the lab runs.
    writeFileSync(script, [
      'param([string]$Guest, [string]$InputsFile, [string]$Out)',
      "$ErrorActionPreference = 'Stop'",
      '$lines = Get-Content $Guest',
      "$start = ($lines | Select-String -Pattern '^function New-LabNonce' | Select-Object -First 1).LineNumber - 1",
      "$end = ($lines | Select-String -Pattern '^# The v2 flow as the Control Plane account' | Select-Object -First 1).LineNumber - 2",
      'Invoke-Expression ($lines[$start..$end] -join "`n")',
      '$in = Get-Content -Raw $InputsFile | ConvertFrom-Json',
      '$Authority = $in.authority',
      '$script:Signer = Get-LabSigner',
      "$fence = ('" + JSON.stringify(FENCE) + "' | ConvertFrom-Json)",
      "$plain = New-LabReceipt 'lab-check' $fence",
      "$other = New-LabReceipt 'lab-check-2' $fence @{ issuer = 'albera-test-approval-authority'; leaseGeneration = 6 }",
      '$keys = @([ordered]@{ kid = $Authority.kid; spki = $Authority.spki })',
      "$cfg = [ordered]@{ pipeName = 'p'; database = 'C:\\x\\j.sqlite'; authorityKeys = $keys; controlPlaneSid = 'S-1-5-80-1'; generation = 7; leaseId = $Authority.leaseId; policyVersion = $Authority.policyVersion }",
      '@{ plain = $plain; other = $other; config = ($cfg | ConvertTo-Json -Compress -Depth 4) } | ConvertTo-Json -Depth 5 | Set-Content -Encoding Ascii -Path $Out',
    ].join('\r\n'));
    const out = path.join(temp, 'sign-check.json');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Guest', path.join(root, 'test', 'windows-service-lab', 'lab-guest.ps1'), '-InputsFile', path.join(temp, 'lab-inputs.json'), '-Out', out], { stdio: 'pipe', timeout: 60_000, windowsHide: true });
    const result = JSON.parse(readFileSync(out, 'utf8'));
    const publicKey = createPublicKey({ key: Buffer.from(inputs.authority.spki, 'base64'), format: 'der', type: 'spki' });
    for (const name of ['plain', 'other']) {
      const bytes = Buffer.from(result[name].receipt, 'base64');
      const signature = Buffer.from(result[name].signature, 'base64');
      assert.equal(signature.length, 64, `${name}: an IEEE P1363 pair`);
      assert.ok(verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), `${name}: signature`);
      assert.ok(bytes.length <= 1280, `${name}: within the receipt size limit`);
    }
    const plain = Buffer.from(result.plain.receipt, 'base64');
    assert.deepEqual(JSON.parse(JSON.stringify(validateReceiptV2(plain, contextFor(plain)))), { ok: true, receipt: JSON.parse(plain) });
    const other = Buffer.from(result.other.receipt, 'base64');
    assert.deepEqual(JSON.parse(JSON.stringify(validateReceiptV2(other, contextFor(other)))), { ok: false, code: 'issuer', field: 'issuer' }, 'the override reaches the receipt');
    assert.deepEqual(JSON.parse(result.config), { pipeName: 'p', database: 'C:\\x\\j.sqlite', authorityKeys: [{ kid: inputs.authority.kid, spki: inputs.authority.spki }], controlPlaneSid: 'S-1-5-80-1', generation: 7, leaseId: inputs.authority.leaseId, policyVersion: inputs.authority.policyVersion }, 'authorityKeys is an array of one object; the lease and policy are the ones the receipts name');
  });
});
