import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source-level guards for WebAuthn presence and the approver key list in the Approval Authority (docs/architecture/approver-webauthn.md, phase 2). They run on every OS and need no .NET SDK.
// They pin the things a behaviour test cannot see: that the code and the design document name the same constants, that the key store is written the way policy.json is, that nothing in the
// verifier can sign, and that the key verbs and the store are wired where the contract says.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const directory = ['src', 'runtime', 'windows-approval-authority'];
const stripComments = (source) => source.replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/ .*$/gmu, '');
const source = Object.fromEntries(['WebAuthnPresence.cs', 'ApproverKeys.cs', 'ApproverKeyStore.cs', 'Protocol.cs', 'AuthorityCore.cs', 'AuthorityConfig.cs', 'ServiceHost.cs', 'Program.cs', 'AuthorityRuntime.cs', 'TestSeam.cs', 'ReceiptBuilder.cs', 'PolicyStore.cs']
  .map((name) => [name, read(...directory, name)]));
const code = Object.fromEntries(Object.entries(source).map(([name, text]) => [name, stripComments(text)]));
const design = read('docs', 'architecture', 'approver-webauthn.md');
const authorityDoc = read('docs', 'architecture', 'approval-authority.md');

test('the constants of the verifier are the design document\'s: rp id, origin, flags, 37 bytes, ES256 / RS256 and the two message domains', () => {
  const web = code['WebAuthnPresence.cs'], keys = code['ApproverKeys.cs'];
  assert.match(web, /RpId = "approver\.albera\.local", Origin = "albera:\/\/approver"/u);
  assert.match(web, /AuthenticatorDataBytes = 37,/u);
  assert.match(web, /FlagUserPresent = 0x01, FlagUserVerified = 0x04, FlagAttestedData = 0x40, FlagExtensions = 0x80/u);
  assert.match(web, /"\{\{\\"type\\":\\"webauthn\.get\\",\\"challenge\\":\\"\{Base64Text\.EncodeUrl\(SHA256\.HashData\(message\)\)\}\\",\\"origin\\":\\"\{Origin\}\\",\\"crossOrigin\\":false\}\}"/u, 'the client data is exactly the documented JSON');
  assert.match(web, /Es256 = -7, Rs256 = -257/u);
  assert.match(web, /DSASignatureFormat\.Rfc3279DerSequence/u, 'ES256 signatures are ASN.1 DER');
  assert.match(web, /RSASignaturePadding\.Pkcs1/u);
  assert.match(web, /HashAlgorithmName\.SHA256/u);
  assert.match(keys, /AddDomain = "albera\.keyadd\.v1", RemoveDomain = "albera\.keyremove\.v1"/u);
  assert.match(keys, /MaxKeys = 16/u);
  assert.match(keys, /ChallengeTtlSeconds = 120/u);
  assert.match(keys, /Ids\.NewBits128\(\)/u, 'a challenge is 128 random bits');
  for (const text of ['approver.albera.local', 'albera://approver', 'albera.keyadd.v1', 'albera.keyremove.v1', 'approver-keys.json', '"crossOrigin":false']) assert.ok(design.includes(text), `the design document names ${text}`);
  for (const text of ['approver.albera.local', 'albera.keyadd.v1', 'albera.keyremove.v1', 'approver-keys.json', 'key_challenge', 'key_add', 'key_remove', 'challenge_unknown', 'challenge_expired', 'key_exists', 'key_unknown', 'last_key', 'too_many_keys', 'config_approver_keys']) {
    assert.ok(authorityDoc.includes(text), `docs/architecture/approval-authority.md documents ${text}`);
  }
});

test('the verifier and the key set only verify: no private key is created, imported, exported or used to sign in the new files', () => {
  for (const name of ['WebAuthnPresence.cs', 'ApproverKeys.cs', 'ApproverKeyStore.cs']) {
    assert.equal(/SignData|SignHash|\.Sign\(|ImportPkcs8|ImportECPrivateKey|ImportRSAPrivateKey|ExportPkcs8|ExportECPrivateKey|ExportRSAPrivateKey|ExportParameters\(true\)|CngKey\.(?:Create|Import)/u.test(code[name]), false, `${name} holds only public keys`);
    assert.equal(/Process\.Start|HttpClient|Environment\.GetEnvironmentVariable|KeyCredentialManager|Windows\.Security\.Credentials|webauthn\.dll|WebAuthN/u.test(code[name]), false, `${name} talks to nothing`);
  }
  assert.equal(/\[DllImport/u.test(code['WebAuthnPresence.cs'] + code['ApproverKeys.cs']), false, 'no P/Invoke in the verifier: pure BCL');
});

test('the only thing that throws away input is a catch for crypto errors: the verifier catches CryptographicException / ArgumentException and nothing wider', () => {
  for (const name of ['WebAuthnPresence.cs', 'ApproverKeys.cs']) {
    for (const match of code[name].matchAll(/catch\s*\(([^)]*)\)/gu)) assert.match(match[1], /^Exception ex\) when \(ex is CryptographicException or ArgumentException$|^Exception ex$/u, `${name}: catch (${match[1]})`);
  }
  assert.equal(/catch\s*\(Exception ex\)\s*\{/u.test(code['WebAuthnPresence.cs']), false, 'no blanket catch');
});

test('approver-keys.json is written only by ApproverKeyStore.cs, the way policy.json is: create-new temp, flushed, trust-checked, moved with write-through, read back', () => {
  const store = code['ApproverKeyStore.cs'];
  assert.match(store, /FileName = "approver-keys\.json"/u);
  assert.match(store, /Path\.Combine\(Path\.GetDirectoryName\(configPath\)!, FileName\)/u, 'next to the config');
  const write = store.slice(store.indexOf('public static PersistResult Write('), store.indexOf('private static bool SameKeys('));
  const order = ['FileMode.CreateNew', 'stream.Write(content)', 'stream.Flush(flushToDisk: true)', 'ServicePathGuard.IsTrustedConfigFile(temp, stream)', 'MoveFileExW(temp, path', 'Read(path, legacy', 'PersistResult.Faulted'].map((token) => write.indexOf(token));
  assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `temp -> write -> flush -> trust check -> move -> read back -> fault (${order})`);
  assert.match(write, /FileOptions\.WriteThrough/u);
  assert.match(store, /MoveReplaceExisting = 0x1, MoveWriteThrough = 0x8/u);
  assert.deepEqual([...store.matchAll(/FileMode\.(\w+), FileAccess\.(\w+)/gu)].map((m) => `${m[1]}:${m[2]}`), ['Open:Read', 'CreateNew:Write']);
  assert.equal([...store.matchAll(/File\.Delete\(/gu)].length, 1, 'File.Delete removes only the temp file');
  assert.equal([...store.matchAll(/\[DllImport/gu)].length, 1, 'one P/Invoke, for the move');
  const read = store.slice(store.indexOf('public static Loaded? Read('), store.indexOf('private static Loaded? Parse('));
  assert.ok(read.indexOf('IsTrustedConfigFile(path, stream)') > 0 && read.indexOf('IsTrustedConfigFile(path, stream)') < read.indexOf('stream.Length > MaxFileBytes') && read.indexOf('stream.Length > MaxFileBytes') < read.indexOf('Parse(bytes, legacy)'), 'trust -> size -> shape');
  assert.match(store, /top-level|TopLevelNames = \["v", "revision", "keys", "signCounts"\]/u, 'exactly the documented keys');
  assert.match(store, /ApproverKeyRules\.TryReadList\(root\.GetProperty\("keys"\), legacy\)/u, 'every record goes through the same reader as the config and the wire');
  for (const name of ['AuthorityCore.cs', 'Protocol.cs', 'ApproverKeys.cs', 'WebAuthnPresence.cs']) assert.equal(/File\.|FileStream|FileMode|MoveFileEx/u.test(code[name]), false, `${name} touches no file`);
});

test('the key list changes in one place under one lock: write first (revision + 1), swap after, a write that did not happen changes nothing, a read-back that disagrees faults the set', () => {
  const keys = code['ApproverKeys.cs'];
  const commit = keys.slice(keys.indexOf('private string? Commit('));
  assert.ok(commit.indexOf('ApproverKeyStore.Write(file, revision + 1') > 0 && commit.indexOf('ApproverKeyStore.Write(file') < commit.indexOf('(keys, signCounts, revision) = ('), 'file before memory');
  assert.match(commit, /if \(result == PersistResult\.Faulted\) faulted = true;\s*if \(result != PersistResult\.Written\) return AuthorityCodes\.AuthorityUnavailable;/u);
  for (const method of ['public KeyOutcome IssueChallenge(', 'public KeyOutcome Add(', 'public KeyOutcome Remove(']) assert.ok(keys.slice(keys.indexOf(method), keys.indexOf(method) + 200).includes('lock (gate)'), `${method} runs under the lock`);
  assert.equal([...keys.matchAll(/Commit\(/gu)].length, 4, 'declared once; called from Verify (a moved sign count), Add and Remove');
  assert.equal([...keys.matchAll(/ApproverKeyStore\.Write\(/gu)].length, 2, 'one call here (Commit) and one for the seed');
  // key_add and key_remove check the challenge before anything else is looked at, and the proofs before the commit
  const add = keys.slice(keys.indexOf('public KeyOutcome Add('), keys.indexOf('public KeyOutcome Remove('));
  const steps = ['TakeChallenge(challenge, KeyOp.Add', 'ApproverKeyRules.Overlap', 'Check(message, by', 'ApproverKeyVerifier.Verify(candidate, message, newKey', 'Commit(next, counts)'].map((token) => add.indexOf(token));
  assert.ok(steps.every((at) => at > 0) && steps.every((at, i) => i === 0 || at > steps[i - 1]), `challenge -> duplicate -> by -> newKey -> commit (${steps})`);
  const remove = keys.slice(keys.indexOf('public KeyOutcome Remove('), keys.indexOf('private static string CodeOf('));
  const removeSteps = ['TakeChallenge(challenge, KeyOp.Remove', 'ApproverKeyCodes.LastKey', 'Check(KeyMessages.Remove(doomed, challenge), by', 'Commit(next, counts)'].map((token) => remove.indexOf(token));
  assert.ok(removeSteps.every((at) => at > 0) && removeSteps.every((at, i) => i === 0 || at > removeSteps[i - 1]), `challenge -> last key -> by -> commit (${removeSteps})`);
  // a challenge is used up the moment it is presented, before its expiry or binding is judged
  const take = keys.slice(keys.indexOf('private string? TakeChallenge('), keys.indexOf('// Called under the lock: write first'));
  assert.ok(take.indexOf('outstanding = null;') > 0 && take.indexOf('outstanding = null;') < take.indexOf('ChallengeExpired') && take.indexOf('ChallengeExpired') < take.indexOf('issued.Op == op'), 'used up -> expired -> bound');
  assert.match(keys, /outstanding = new\(op, keyId, Ids\.NewBits128\(\), expiresAt\);/u, 'one outstanding challenge');
});

test('key_remove resets the policy first: the hook runs after the removal is authorized and before the key list is written, under the policy lock taken first, and it only ever writes careful', () => {
  const keys = code['ApproverKeys.cs'];
  const remove = keys.slice(keys.indexOf('public KeyOutcome Remove('), keys.indexOf('private static string CodeOf('));
  const steps = ['Check(KeyMessages.Remove(doomed, challenge), by', 'beforeRemoval?.Invoke(new KeyList(next))', 'Commit(next, counts)'].map((token) => remove.indexOf(token));
  assert.ok(steps.every((at) => at > 0) && steps.every((at, i) => i === 0 || at > steps[i - 1]), `authorized -> policy reset -> key list written (${steps})`);
  const core = code['AuthorityCore.cs'];
  const keyRemove = core.slice(core.indexOf('public KeyOutcome KeyRemove('), core.indexOf('public Outcome Status('));
  assert.ok(keyRemove.indexOf('policy.With(') > 0 && keyRemove.indexOf('policy.With(') < keyRemove.indexOf('keys.Remove(') && keyRemove.indexOf('keys.Remove(') < keyRemove.indexOf('policy.ResetIfSignerGone(remaining)'), 'policy lock, then the key set\'s (the order PolicyStore.Change uses)');
  const store = code['PolicyStore.cs'];
  const reset = store.slice(store.indexOf('public (string? Code, TierPolicy? Reset) ResetIfSignerGone('), store.indexOf('private static byte[] Envelope('));
  assert.match(reset, /TierPolicy\.TryCreate\(current\.Revision \+ 1, TierPolicy\.Careful, \[\]\)/u, 'careful, revision + 1');
  assert.match(reset, /Change\(careful, null, /u, 'through the store\'s own write path, with no proof (careful loosens nothing)');
  assert.match(reset, /if \(authorized is null \|\| authorizedProof is null \|\| identity is null\) return \(null, null\);/u, 'a policy with no proof is left alone');
  assert.match(reset, /remaining\.Verify\(PolicyChange\.Message\(authorized, identity\.Kid, identity\.Audience\), authorizedProof\) == PresenceResult\.Verified\) return \(null, null\);/u, 'a proof the remaining keys can still vouch for is left alone');
  assert.match(code['Protocol.cs'], /if \(policyReset\) w\.WriteBoolean\("policyReset", true\);/u, 'policyReset appears only when true');
});

test('the key verbs\' own codes are a separate list, so the Control Plane\'s list (AuthorityCodes, mirrored by the pipe client helper) did not change', () => {
  const codes = (text, name) => [...text.slice(text.indexOf(`class ${name}`)).split('}')[0].matchAll(/= "([a-z_]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(codes(source['ApproverKeys.cs'], 'ApproverKeyCodes'), ['challenge_unknown', 'challenge_expired', 'key_exists', 'key_unknown', 'last_key', 'too_many_keys']);
  assert.deepEqual(codes(source['ReceiptBuilder.cs'], 'AuthorityCodes'), ['authority_unavailable', 'request_invalid', 'request_expired', 'human_denied', 'presence_unavailable', 'presence_mismatch', 'queue_full']);
});

test('the key verbs are on the approver pipe only, `list` is as it was, and the receipt names the key that verified', () => {
  const protocol = code['Protocol.cs'];
  assert.deepEqual([...protocol.matchAll(/\(PipeRole\.(\w+), "(key\w*)"\) =>/gu)].map((m) => `${m[1]}:${m[2]}`), ['Approver:keys', 'Approver:key_challenge', 'Approver:key_add', 'Approver:key_remove']);
  assert.match(protocol, /HasKeys\(r, \["v", "verb"\], optional: \["afterSeq"\]\)/u, 'list takes v, verb and afterSeq only');
  assert.match(protocol, /HasKeys\(r, \["v", "verb", "key", "challenge", "by", "newKey"\]\)/u, 'key_add: the contract\'s frame');
  assert.match(protocol, /HasKeys\(r, \["v", "verb", "keyId", "challenge", "by"\]\)/u, 'key_remove: the contract\'s frame');
  assert.match(protocol, /HasKeys\(r, \["v", "verb", "op", "keyId"\]\)/u, 'key_challenge: the contract\'s frame');
  assert.match(protocol, /new\(ApproverKeyRules\.TryRead\(keyFields\)\)|ApproverKeyRules\.TryRead\(keyFields\) is not \{ \} candidate/u, 'a record from the wire needs the derived id (no legacy exemption)');
  const core = code['AuthorityCore.cs'];
  assert.match(core, /presence\.Verify\(PresenceMessage\.Build\(entry\.ApprovalId, entry\.ActionDigest, entry\.Challenge\), proof, out signerKeyId\)/u);
  assert.match(core, /identity with \{ ApproverKeyId = signerKeyId \}/u);
  assert.match(core, /ReceiptBuilder\.Build\(entry, signedBy,/u, 'the receipt carries the signer\'s key id');
  assert.equal(/ApproverKeySet/u.test(code['ReceiptBuilder.cs']), false, 'the receipt contract is untouched');
});

test('start-up reads the key store before the policy (it verifies the policy\'s proof), seeds it only in the service, never in service-check, and a bad store is exit 80', () => {
  const host = code['ServiceHost.cs'];
  assert.ok(host.indexOf('AuthorityConfig.TryLoad(configPath') < host.indexOf('LoadApproverKeys(config, seed: true') && host.indexOf('LoadApproverKeys(config, seed: true') < host.indexOf('PolicyStore.TryLoad(configPath') && host.indexOf('PolicyStore.TryLoad(configPath') < host.indexOf('RunLoopAsync(config, policy'), 'config -> keys -> policy -> run');
  assert.match(host, /ReportStopped\(ExitCodes\.ApproverKeysInvalid\)/u);
  assert.match(host, /approverKeys\.ForStoredProofs/u, 'the policy proof is checked against the key list without moving sign counts');
  assert.match(code['Program.cs'], /LoadApproverKeys\(config, seed: false, out _\)/u, 'service-check creates nothing');
  assert.match(code['Program.cs'], /return ExitCodes\.ApproverKeysInvalid;/u);
  assert.match(code['TestSeam.cs'], /LoadApproverKeys\(config, seed: true, out _\)/u);
  assert.match(code['AuthorityRuntime.cs'], /ApproverKeySet\.Open\(config, UnixNow, seed: false, out _, out _\) \?\? throw/u, 'the running core uses the list the host already loaded and seeded');
  assert.match(read(...directory, 'ExitCodes.cs'), /ApproverKeysInvalid = 80;/u);
  assert.match(code['AuthorityRuntime.cs'], /PolicyInvalid|RunProductionAsync\(AuthorityConfig config, PolicyStore policy, CancellationToken stop, Action onReady\)/u);
});

test('the config names its keys either as the older pair or as approverKeys, never both (config_approver_keys), and the store never reads the config again once it exists', () => {
  const config = code['AuthorityConfig.cs'];
  assert.match(config, /ApproverKeys = "config_approver_keys"/u);
  assert.match(config, /if \(list && PairKeys\.Any\(seen\.Contains\)\) \{ reason = Reason\.ApproverKeys; return null; \}/u);
  assert.match(config, /ApproverKeyRules\.TryReadList\(root\.GetProperty\(KeyListKey\)\)/u, 'a list in the config: no exemption for a chosen id');
  assert.match(config, /requireDerivedId: false\) \?\? throw new InvalidOperationException\(\)/u, 'only the pair keeps the id the installer gave it');
  const keys = code['ApproverKeys.cs'];
  const open = keys.slice(keys.indexOf('public static ApproverKeySet? Open('), keys.indexOf('/// <summary>The registered keys (a snapshot).</summary>'));
  assert.ok(open.indexOf('ApproverKeyStore.Read(') > 0 && open.indexOf('if (exists)') > open.indexOf('ApproverKeyStore.Read(') && open.indexOf('if (!seed)') > open.indexOf('if (exists)'), 'file first; the config\'s keys only when there is none');
  assert.match(open, /if \(loaded is null\) return null;/u, 'a bad file is never replaced by the config\'s keys');
});
