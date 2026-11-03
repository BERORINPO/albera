import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SECRET_LIMITS, createControlPlaneSecretStore } from '../src/runtime/control-plane-secret-store.mjs';
import { buildPipeClient, getUnavailableReason, makeTrustedTempDirectory } from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged: the Node adapter and raw frames against the REAL pipe client helper in secret mode, with the real DPAPI (CurrentUser scope).
// What this proves: the round trip for the account running the test, that the entropy is part of the key, that a damaged blob or a wrong entropy is refused with the fixed word,
// and that the helper's bounds hold. It does NOT prove that another identity (Administrator, a plain user, another virtual account) cannot open a blob, and it does not run as
// NT SERVICE\AlberaControlPlane: both were measured in the lab with the probe (PR #175) and the same check with this helper is a lab item, not claimed here.
const VALUE = 'sk-ant-oat01-SYNTHETIC_INTEGRATION_TOKEN_not_a_real_credential';
const NAME = 'claude-oauth-token';
const API_NAME = 'anthropic-api-key';
const WORDS = ['invalid_request', 'too_large', 'protect_failed', 'unprotect_failed', 'internal_error'];

const frame = (payload) => {
  const head = Buffer.alloc(4);
  head.writeInt32LE(payload.length);
  return Buffer.concat([head, payload]);
};
const request = (op, entropy, data) => frame(Buffer.concat([Buffer.from([op, entropy.length]), Buffer.from(entropy, 'ascii'), Buffer.from(data)]));

describe('secret mode of the real helper: DPAPI CurrentUser round trip, refusals and bounds', { skip: getUnavailableReason(), timeout: 600_000 }, () => {
  let root, helper, helperSha256, secrets;
  before(async () => {
    root = makeTrustedTempDirectory('albera-secret-store-it-');
    helper = await buildPipeClient(path.join(root, 'helper'));
    helperSha256 = JSON.parse(readFileSync(`${helper}.manifest.json`, 'utf8')).sha256; // the pin a caller holds, as the room's desktop settings do
    secrets = path.join(root, 'secrets');
    mkdirSync(secrets);
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  const store = () => createControlPlaneSecretStore({ secretsDir: secrets, helperPath: helper, helperSha256 });
  /** Run the helper once with these stdin bytes; resolves with { stdout, stderr, exit }. The stdin is closed after the bytes, as Node does. */
  const rawHelper = (bytes, args = ['secret']) => new Promise((resolve, reject) => {
    const child = spawn(helper, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('the helper did not finish')); }, 20_000); // our own child only
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.stdin.on('error', () => {});
    child.once('close', (exit) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), exit }); });
    child.stdin.end(bytes);
  });
  /** The one reply frame, split: { status, body }. Fails the test when it is not exactly one well-formed frame. */
  const replyOf = ({ stdout }) => {
    assert.ok(stdout.length >= 5 && stdout.readInt32LE(0) === stdout.length - 4, 'exactly one reply frame');
    return { status: stdout[4], body: stdout.subarray(5) };
  };
  const refusalOf = (result) => {
    const { status, body } = replyOf(result);
    assert.equal(status, 1);
    assert.equal(result.stderr.length, 0, 'nothing on stderr');
    return body.toString('latin1');
  };
  const codeOf = async (promise) => { try { await promise; } catch (error) { return error.code; } return assert.fail('expected a rejection'); };

  it('the adapter round trip with the real DPAPI: the file is a blob and holds neither the value nor its text in any encoding, the status has the hash prefix', async () => {
    const secretStore = store();
    const saved = await secretStore.save(NAME, VALUE);
    assert.equal(saved.sha256Prefix.length, 8);
    assert.deepEqual(readdirSync(secrets).sort(), [`${NAME}.dpapi`, `${NAME}.meta`]);
    const meta = readFileSync(path.join(secrets, `${NAME}.meta`), 'utf8');
    assert.deepEqual(JSON.parse(meta), { sha256Prefix: saved.sha256Prefix, savedAt: saved.savedAt });
    assert.equal(meta.includes(VALUE), false);
    const blob = readFileSync(path.join(secrets, `${NAME}.dpapi`));
    assert.ok(blob.length > VALUE.length && blob.length < SECRET_LIMITS.maxBlobBytes);
    for (const encoding of ['latin1', 'utf16le', 'base64']) assert.equal(blob.toString(encoding).includes(Buffer.from(VALUE).toString(encoding)), false, `no plaintext as ${encoding}`);
    assert.equal(blob.subarray(0, 4).readUInt32LE(0), 1, 'a DPAPI blob starts with dwVersion 1');
    assert.equal((await secretStore.load(NAME)).toString(), VALUE);
    assert.deepEqual(await secretStore.status(NAME), saved);
    assert.deepEqual(await secretStore.verify(NAME), { present: true, readable: true, sha256Prefix: saved.sha256Prefix, savedAt: saved.savedAt });
    await secretStore.save(NAME, VALUE);
    assert.notDeepEqual(readFileSync(path.join(secrets, `${NAME}.dpapi`)), blob, 'DPAPI salts every protect: the same value gives another blob');
    assert.equal(await secretStore.erase(NAME), true);
    assert.deepEqual(readdirSync(secrets), [], 'erase removed the blob and the meta file');
    assert.equal(await codeOf(secretStore.load(NAME)), 'not_found');
  });

  it('the largest value (4096 bytes) and binary values come back byte for byte', async () => {
    const secretStore = store();
    for (const value of [Buffer.alloc(SECRET_LIMITS.maxValueBytes, 'k'), Buffer.from([0, 1, 2, 255, 254, 0]), Buffer.from('日本語のトークン')]) {
      await secretStore.save(API_NAME, value);
      assert.deepEqual(await secretStore.load(API_NAME), value);
    }
    await secretStore.erase(API_NAME);
  });

  it('the entropy is part of the key: a blob copied under another name does not open, and neither does a damaged, truncated or random one (all unprotect_failed)', async () => {
    const secretStore = store();
    await secretStore.save(NAME, VALUE);
    const good = readFileSync(path.join(secrets, `${NAME}.dpapi`));
    copyFileSync(path.join(secrets, `${NAME}.dpapi`), path.join(secrets, `${API_NAME}.dpapi`));
    assert.equal(await codeOf(secretStore.load(API_NAME)), 'unprotect_failed');
    assert.deepEqual(await secretStore.verify(API_NAME), { present: true, readable: false, sha256Prefix: null, savedAt: null });
    assert.deepEqual(await secretStore.status(API_NAME), { present: true, sha256Prefix: null, savedAt: null }, 'status does not open the blob');
    const flipped = Buffer.from(good);
    flipped[flipped.length - 5] ^= 0xff;
    for (const damaged of [flipped, good.subarray(0, good.length - 1), good.subarray(0, 40), Buffer.alloc(300, 0x41), Buffer.from('not a blob')]) {
      writeFileSync(path.join(secrets, `${API_NAME}.dpapi`), damaged);
      assert.equal(await codeOf(secretStore.load(API_NAME)), 'unprotect_failed');
    }
    assert.equal((await secretStore.load(NAME)).toString(), VALUE, 'the original is untouched');
    await secretStore.erase(NAME);
    await secretStore.erase(API_NAME);
  });

  it('raw frames: protect then unprotect works, the reply carries no stderr and exits 0', async () => {
    const entropy = 'albera.raw-check.v1';
    const protectedReply = await rawHelper(request(1, entropy, 'raw plaintext'));
    assert.equal(protectedReply.exit, 0);
    assert.equal(protectedReply.stderr.length, 0);
    const { status, body } = replyOf(protectedReply);
    assert.equal(status, 0);
    const opened = await rawHelper(request(2, entropy, body));
    assert.equal(opened.exit, 0);
    assert.equal(replyOf(opened).status, 0);
    assert.equal(replyOf(opened).body.toString(), 'raw plaintext');
    const wrong = await rawHelper(request(2, 'albera.raw-check.v2', body));
    assert.equal(wrong.exit, 0);
    assert.equal(refusalOf(wrong), 'unprotect_failed');
    assert.equal(wrong.stdout.toString('latin1').includes('raw plaintext'), false);
  });

  it('raw frames: the bounds and the grammar are refused with a fixed word and exit 64 (no DPAPI call, no text)', async () => {
    const entropy = 'albera.raw-check.v1';
    const cases = {
      'plaintext of 4097 bytes': [request(1, entropy, Buffer.alloc(SECRET_LIMITS.maxValueBytes + 1, 1)), 'too_large'],
      'a blob of 8193 bytes': [request(2, entropy, Buffer.alloc(SECRET_LIMITS.maxBlobBytes + 1, 1)), 'too_large'],
      'a length above any request, body never sent': [Buffer.from([0xff, 0xff, 0xff, 0x7f]), 'too_large'],
      'no bytes at all': [Buffer.alloc(0), 'invalid_request'],
      'a header cut short': [Buffer.from([4, 0]), 'invalid_request'],
      'a body cut short': [Buffer.concat([Buffer.from([20, 0, 0, 0]), Buffer.from([1, 3, 97])]), 'invalid_request'],
      'a negative length': [Buffer.from([0xff, 0xff, 0xff, 0xff]), 'invalid_request'],
      'a length of zero': [Buffer.alloc(4), 'invalid_request'],
      'an unknown operation': [request(3, entropy, 'x'), 'invalid_request'],
      'operation zero': [request(0, entropy, 'x'), 'invalid_request'],
      'an empty entropy': [frame(Buffer.from([1, 0, 120, 120])), 'invalid_request'],
      'an entropy name in capitals': [request(1, 'Albera.Upper.v1', 'x'), 'invalid_request'],
      'an entropy name with a space': [request(1, 'albera x.v1', 'x'), 'invalid_request'],
      'an entropy name above 64': [request(1, 'a'.repeat(65), 'x'), 'invalid_request'],
      'an entropy length that eats the data': [frame(Buffer.from([1, 5, 97, 98, 99])), 'invalid_request'],
      'no data': [frame(Buffer.concat([Buffer.from([1, entropy.length]), Buffer.from(entropy)])), 'invalid_request'],
    };
    for (const [name, [bytes, word]] of Object.entries(cases)) {
      const result = await rawHelper(bytes);
      assert.equal(refusalOf(result), word, name);
      assert.ok(WORDS.includes(word));
      assert.equal(result.exit, 64, name);
    }
    const largest = await rawHelper(request(1, entropy, Buffer.alloc(SECRET_LIMITS.maxValueBytes, 1)));
    assert.equal(replyOf(largest).status, 0, 'exactly 4096 is accepted');
  });

  it('a garbage blob through the helper is unprotect_failed with exit 0, and the word says nothing about why', async () => {
    for (const blob of [Buffer.alloc(1, 1), Buffer.alloc(200, 7), Buffer.alloc(SECRET_LIMITS.maxBlobBytes, 9)]) {
      const result = await rawHelper(request(2, 'albera.raw-check.v1', blob));
      assert.equal(result.exit, 0);
      assert.equal(refusalOf(result), 'unprotect_failed');
    }
  });

  it('the older modes did not change: the one-request mode still wants its JSON line (invalid_request, exit 64), and a second argument is not the secret mode', async () => {
    const claim = await rawHelper(Buffer.from('{}\n'), []);
    assert.equal(claim.exit, 64);
    assert.deepEqual(JSON.parse(claim.stdout.toString()), { ok: false, code: 'invalid_request' });
    const extra = await rawHelper(request(1, 'albera.raw-check.v1', 'x'), ['secret', 'extra']);
    assert.equal(extra.exit, 64, 'treated as the one-request mode, which refuses this input');
    assert.deepEqual(JSON.parse(extra.stdout.toString()), { ok: false, code: 'invalid_request' });
  });
});
