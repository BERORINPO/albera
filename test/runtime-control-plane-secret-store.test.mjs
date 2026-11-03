import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it, mock } from 'node:test';
import { SECRET_LIMITS, SECRET_NAMES, SECRET_STORE_ERROR_CODES, SecretStoreError, createControlPlaneSecretStore } from '../src/runtime/control-plane-secret-store.mjs';
import { createFakeControlPlaneSecretStore } from '../src/runtime/fake-control-plane-secret-store.mjs';

// Pure and scripted-helper tests: every OS, no .NET, no DPAPI. The scripted helper plays the helper side of the frames documented in SecretMode.cs, with a reversible stand-in for DPAPI
// (the blob is the entropy, a bar and the reversed bytes), so what these tests prove is the adapter's framing, file handling and error mapping, and that the Fake behaves like it.
// The real helper with the real DPAPI is runtime-control-plane-secret-store.integration.test.mjs. Whether another identity can open a blob was measured in the lab (PR #175), not here.
const VALUE = 'sk-ant-oat01-SYNTHETIC_TEST_TOKEN_not_a_real_credential';
const OTHER = 'sk-ant-oat01-ANOTHER_SYNTHETIC_TOKEN';
const NAME = 'claude-oauth-token';
const API_NAME = 'anthropic-api-key';
const root = mkdtempSync(path.join(os.tmpdir(), 'albera-secret-store-unit-'));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const freshDir = () => {
  const dir = path.join(root, `secrets-${counter += 1}`);
  mkdirSync(dir);
  return dir;
};
const sha8 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);
const failure = async (promise) => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };
const codeOf = async (promise) => {
  const error = await failure(promise);
  assert.ok(error instanceof SecretStoreError, `a SecretStoreError, got ${error}`);
  assert.equal(error.message, error.code, 'the message is the code and nothing else');
  assert.ok(SECRET_STORE_ERROR_CODES.includes(error.code), `a documented code: ${error.code}`);
  return error.code;
};

let helperCounter = 0;
const DEFAULT_HELPER_TEXT = 'not a real executable';
const digestOf = (text) => createHash('sha256').update(text).digest('hex');
/** A stand-in helper file plus a matching SHA-256 manifest, like `npm run build:windows-broker` writes. */
function makeHelper(content = DEFAULT_HELPER_TEXT) {
  const helperPath = path.join(root, `helper-${helperCounter += 1}.exe`);
  writeFileSync(helperPath, content);
  writeFileSync(`${helperPath}.manifest.json`, JSON.stringify({ sha256: digestOf(content) }));
  return helperPath;
}
/** The two options every store needs: the helper and the digest of the build the caller pins (the manifest of a helper made by makeHelper). */
const pinned = (helperPath) => ({ helperPath, helperSha256: JSON.parse(readFileSync(`${helperPath}.manifest.json`, 'utf8')).sha256 });

const replyFrame = (status, body) => {
  const payload = Buffer.concat([Buffer.from([status]), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')]);
  const head = Buffer.alloc(4);
  head.writeInt32LE(payload.length);
  return Buffer.concat([head, payload]);
};
const refusal = (word, exit) => ({ reply: replyFrame(1, word), exit });

/** The stand-in for DPAPI. Returns the reply to send and the exit code. */
function fakeDpapi({ op, entropy, data }) {
  if (op === 1) return { reply: replyFrame(0, Buffer.concat([Buffer.from(`${entropy}|`), Buffer.from(data).reverse()])), exit: 0 };
  const bar = data.indexOf('|');
  if (bar < 0 || data.subarray(0, bar).toString() !== entropy) return refusal('unprotect_failed', 0);
  return { reply: replyFrame(0, Buffer.from(data.subarray(bar + 1)).reverse()), exit: 0 };
}

/**
 * A spawn replacement whose child plays the helper. `behave(request, ctx)` returns { reply, exit } (reply is the whole frame, or null for silence; { hang: true } never closes) and defaults to the DPAPI stand-in.
 * The log keeps what a test needs to look at: the calls, the request frames and reply buffers by reference (to see that they were wiped), and whether the child was killed.
 */
function scriptedHelper(behave = fakeDpapi) {
  const log = { spawns: [], requests: [], replies: [], killed: 0 };
  const spawnImpl = (command, args, options) => {
    log.spawns.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => { log.killed += 1; };
    const chunks = [];
    child.stdin.on('data', (chunk) => { chunks.push(chunk); log.requests.push(chunk); });
    child.stdin.on('end', () => {
      const request = Buffer.concat(chunks);
      const length = request.readInt32LE(0);
      assert.equal(length, request.length - 4, 'one whole frame');
      const entropyLength = request[5];
      const result = behave({ op: request[4], entropy: request.subarray(6, 6 + entropyLength).toString('ascii'), data: request.subarray(6 + entropyLength) }, { log });
      setImmediate(() => {
        if (result.hang) return; // a helper that never answers and never exits
        if (result.reply !== null) { log.replies.push(result.reply); child.stdout.write(result.reply); }
        child.emit('close', result.exit);
      });
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  return { spawnImpl, log };
}

// ---- the behaviour both stores share ----------------------------------------------------------------------------------------------------------------------------------------
// `make()` returns { store, damage(name), expectedSavedAt? }. `damage` makes the stored credential something this account cannot open.
const IMPLEMENTATIONS = [
  ['Fake', () => {
    const clock = { value: Date.parse('2026-11-03T09:00:00.000Z') };
    const store = createFakeControlPlaneSecretStore({ now: () => new Date(clock.value += 1000) });
    return { store, damage: (name) => store.markUnreadable(name) };
  }],
  ['adapter with a scripted helper', () => {
    const dir = freshDir();
    const { spawnImpl } = scriptedHelper();
    const store = createControlPlaneSecretStore({ secretsDir: dir, ...pinned(makeHelper()), spawnImpl });
    return { store, damage: (name) => writeFileSync(path.join(dir, `${name}.dpapi`), 'damaged blob without a bar') };
  }],
];

for (const [label, make] of IMPLEMENTATIONS) {
  describe(`secret store contract: ${label}`, () => {
    it('saves, reports and loads: the status has the first 8 hex of the SHA-256 and a date, the value is only in load', async () => {
      const { store } = make();
      const saved = await store.save(NAME, VALUE);
      assert.deepEqual({ ...saved, savedAt: typeof saved.savedAt }, { present: true, sha256Prefix: sha8(VALUE), savedAt: 'string' });
      assert.match(saved.savedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
      const status = await store.status(NAME);
      assert.deepEqual(status, saved);
      assert.equal(JSON.stringify([saved, status]).includes(VALUE), false);
      assert.equal(JSON.stringify([saved, status]).includes(sha8(VALUE) + sha8(VALUE)), false);
      const loaded = await store.load(NAME);
      assert.ok(Buffer.isBuffer(loaded));
      assert.equal(loaded.toString('utf8'), VALUE);
    });

    it('keeps one credential per name, and a save replaces the earlier one', async () => {
      const { store } = make();
      await store.save(NAME, VALUE);
      await store.save(API_NAME, OTHER);
      assert.equal((await store.load(API_NAME)).toString(), OTHER);
      await store.save(NAME, OTHER + OTHER);
      assert.equal((await store.load(NAME)).toString(), OTHER + OTHER);
      assert.equal((await store.status(NAME)).sha256Prefix, sha8(OTHER + OTHER));
      assert.equal((await store.status(API_NAME)).sha256Prefix, sha8(OTHER));
    });

    it('takes bytes as well as text, and never touches the caller\'s buffer or lets the caller reach the stored copy', async () => {
      const { store } = make();
      const mine = Buffer.from(VALUE);
      await store.save(NAME, mine);
      assert.equal(mine.toString(), VALUE, 'the caller\'s buffer is not wiped');
      const first = await store.load(NAME);
      first.fill(0);
      assert.equal((await store.load(NAME)).toString(), VALUE, 'wiping a loaded buffer does not change the store');
      await store.save(NAME, new Uint8Array(Buffer.from(OTHER)).subarray(0, 12));
      assert.equal((await store.load(NAME)).toString(), OTHER.slice(0, 12));
    });

    it('the value limits are 1 to 4096 bytes; anything else is invalid_value and stores nothing', async () => {
      const { store } = make();
      for (const bad of ['', Buffer.alloc(0), 'x'.repeat(SECRET_LIMITS.maxValueBytes + 1), Buffer.alloc(SECRET_LIMITS.maxValueBytes + 1, 1), null, undefined, 42, {}, ['a']]) {
        assert.equal(await codeOf(store.save(NAME, bad)), 'invalid_value');
      }
      assert.equal((await store.status(NAME)).present, false);
      const largest = 'k'.repeat(SECRET_LIMITS.maxValueBytes);
      await store.save(NAME, largest);
      assert.equal((await store.load(NAME)).toString(), largest);
    });

    it('the names are the frozen list of the contract and nothing else: every call refuses any other name with invalid_name', async () => {
      assert.deepEqual([...SECRET_NAMES], ['claude-oauth-token', 'anthropic-api-key']);
      assert.ok(Object.isFrozen(SECRET_NAMES));
      assert.throws(() => SECRET_NAMES.push('x'), TypeError);
      const { store } = make();
      for (const bad of ['', 'A', 'claude-code-token', 'claude-oauth-token ', 'Claude-OAuth-Token', 'anthropic-api-key.v2', 'a/b', 'a\\b', '..', '../claude-oauth-token', 'con:', '__proto__', 'toString', null, undefined, 7, ['claude-oauth-token']]) {
        for (const call of [() => store.save(bad, VALUE), () => store.load(bad), () => store.erase(bad), () => store.status(bad), () => store.verify(bad)]) {
          assert.equal(await codeOf(call()), 'invalid_name', `name ${String(bad)}`);
        }
      }
    });

    it('load without a credential is not_found, status and verify say absent, erase says there was nothing', async () => {
      const { store } = make();
      assert.equal(await codeOf(store.load(NAME)), 'not_found');
      assert.deepEqual(await store.status(NAME), { present: false, sha256Prefix: null, savedAt: null });
      assert.deepEqual(await store.verify(NAME), { present: false, readable: false, sha256Prefix: null, savedAt: null });
      assert.equal(await store.erase(NAME), false);
    });

    it('erase deletes the credential once, and only that one', async () => {
      const { store } = make();
      await store.save(NAME, VALUE);
      await store.save(API_NAME, OTHER);
      assert.equal(await store.erase(NAME), true);
      assert.equal(await store.erase(NAME), false);
      assert.equal(await codeOf(store.load(NAME)), 'not_found');
      assert.equal((await store.status(API_NAME)).present, true);
    });

    it('a credential this account cannot open: status still shows what was saved, verify says not readable, load says unprotect_failed, a new save repairs it', async () => {
      const { store, damage } = make();
      const saved = await store.save(NAME, VALUE);
      assert.deepEqual(await store.verify(NAME), { present: true, readable: true, sha256Prefix: sha8(VALUE), savedAt: saved.savedAt });
      damage(NAME);
      assert.deepEqual(await store.status(NAME), saved, 'status does not look at the blob');
      assert.deepEqual(await store.verify(NAME), { present: true, readable: false, sha256Prefix: null, savedAt: saved.savedAt });
      assert.equal(await codeOf(store.load(NAME)), 'unprotect_failed');
      const repaired = await store.save(NAME, OTHER);
      assert.equal((await store.verify(NAME)).readable, true);
      assert.deepEqual(await store.status(NAME), repaired);
      assert.equal((await store.load(NAME)).toString(), OTHER);
    });

    it('the results are frozen plain data', async () => {
      const { store } = make();
      const saved = await store.save(NAME, VALUE);
      assert.ok(Object.isFrozen(saved) && Object.isFrozen(await store.status(NAME)) && Object.isFrozen(await store.status(API_NAME)));
      assert.ok(Object.isFrozen(await store.verify(NAME)) && Object.isFrozen(await store.verify(API_NAME)));
    });
  });
}

// ---- the adapter alone ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('control-plane-secret-store: files, the helper and its failures (scripted helper)', () => {
  function adapter(behave, options = {}) {
    const dir = options.dir ?? freshDir();
    const helper = scriptedHelper(behave);
    const store = createControlPlaneSecretStore({ secretsDir: dir, ...pinned(makeHelper()), spawnImpl: helper.spawnImpl, ...options.store });
    return { dir, store, ...helper };
  }
  const filesOf = (dir) => readdirSync(dir).sort();

  it('starts the helper in secret mode with no shell and sends the entropy albera.<name>.v1', async () => {
    const seen = [];
    const { store, log } = adapter((request) => { seen.push(request.entropy); return fakeDpapi(request); });
    await store.save(NAME, VALUE);
    await store.save(API_NAME, VALUE);
    await store.load(API_NAME);
    assert.deepEqual(seen, ['albera.claude-oauth-token.v1', 'albera.anthropic-api-key.v1', 'albera.anthropic-api-key.v1']);
    assert.equal(log.spawns.length, 3);
    for (const spawn of log.spawns) {
      assert.deepEqual(spawn.args, ['secret']);
      assert.equal(spawn.options.shell, false);
      assert.equal(spawn.options.windowsHide, true);
      assert.deepEqual(spawn.options.stdio, ['pipe', 'pipe', 'ignore']);
    }
  });

  it('writes <name>.dpapi (the blob) and <name>.meta (hash prefix and date) in the given folder, no temp file left behind, and neither file holds the plaintext', async () => {
    const at = new Date('2026-11-03T10:11:12.345Z');
    const { dir, store } = adapter(undefined, { store: { now: () => at } });
    await store.save(NAME, VALUE);
    assert.deepEqual(filesOf(dir), [`${NAME}.dpapi`, `${NAME}.meta`]);
    const blob = readFileSync(path.join(dir, `${NAME}.dpapi`));
    assert.equal(blob.toString('latin1').includes(VALUE), false, 'the stand-in reverses the bytes; a plaintext copy would show');
    assert.ok(blob.toString('latin1').startsWith('albera.claude-oauth-token.v1|'));
    const metaText = readFileSync(path.join(dir, `${NAME}.meta`), 'utf8');
    assert.deepEqual(JSON.parse(metaText), { sha256Prefix: sha8(VALUE), savedAt: '2026-11-03T10:11:12.345Z' });
    assert.equal(metaText.includes(VALUE), false);
    assert.ok(metaText.length < 256);
    assert.equal(await store.erase(NAME), true);
    assert.deepEqual(filesOf(dir), [], 'erase deletes the blob and the meta file');
  });

  it('status reads the meta file only: it starts no helper, and it does not look at the blob', async () => {
    const { dir, store, log } = adapter();
    const saved = await store.save(NAME, VALUE);
    assert.equal(log.spawns.length, 1);
    writeFileSync(path.join(dir, `${NAME}.dpapi`), 'a blob nobody can open');
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await store.status(NAME), saved);
    assert.equal(log.spawns.length, 1, 'status did not start the helper');
    assert.equal((await store.verify(NAME)).readable, false);
    assert.equal(log.spawns.length, 2, 'verify is the call that opens the blob');
  });

  it('a missing, damaged or foreign meta file shows no hash and no date (present still true), and verify fills the hash in from the value', async () => {
    const { dir, store } = adapter();
    const saved = await store.save(NAME, VALUE);
    const metaFile = path.join(dir, `${NAME}.meta`);
    const cases = {
      missing: null,
      'not JSON': 'not json',
      'extra key': JSON.stringify({ sha256Prefix: saved.sha256Prefix, savedAt: saved.savedAt, value: VALUE }),
      'short hash': JSON.stringify({ sha256Prefix: 'abc', savedAt: saved.savedAt }),
      'upper-case hash': JSON.stringify({ sha256Prefix: 'ABCDEF01', savedAt: saved.savedAt }),
      'date not ISO': JSON.stringify({ sha256Prefix: saved.sha256Prefix, savedAt: 'yesterday' }),
      'a list': '[1,2]',
      'null': 'null',
      'too large': JSON.stringify({ sha256Prefix: saved.sha256Prefix, savedAt: saved.savedAt, pad: 'x'.repeat(300) }),
    };
    for (const [name, text] of Object.entries(cases)) {
      if (text === null) rmSync(metaFile, { force: true }); else writeFileSync(metaFile, text);
      assert.deepEqual(await store.status(NAME), { present: true, sha256Prefix: null, savedAt: null }, name);
      assert.deepEqual(await store.verify(NAME), { present: true, readable: true, sha256Prefix: saved.sha256Prefix, savedAt: null }, name);
    }
  });

  it('erase removes the meta file even when no blob is left, and says false', async () => {
    const { dir, store } = adapter();
    await store.save(NAME, VALUE);
    rmSync(path.join(dir, `${NAME}.dpapi`));
    assert.equal(await store.erase(NAME), false);
    assert.deepEqual(filesOf(dir), []);
  });

  it('a failed protect keeps the old blob and the old meta and leaves no temp file', async () => {
    let fail = false;
    const { dir, store } = adapter((request) => (fail ? refusal('protect_failed', 0) : fakeDpapi(request)));
    const saved = await store.save(NAME, VALUE);
    const before = readFileSync(path.join(dir, `${NAME}.dpapi`));
    fail = true;
    assert.equal(await codeOf(store.save(NAME, OTHER)), 'protect_failed');
    assert.deepEqual(readFileSync(path.join(dir, `${NAME}.dpapi`)), before);
    assert.deepEqual(filesOf(dir), [`${NAME}.dpapi`, `${NAME}.meta`]);
    assert.deepEqual(await store.status(NAME), saved);
    fail = false;
    assert.equal((await store.load(NAME)).toString(), VALUE);
  });

  it('a write that fails after the protect leaves no temp file and is store_unavailable (the folder is in the way)', async () => {
    const dir = freshDir();
    const { store } = adapter(undefined, { dir });
    mkdirSync(path.join(dir, `${NAME}.dpapi`)); // rename over a folder fails
    assert.equal(await codeOf(store.save(NAME, VALUE)), 'store_unavailable');
    assert.deepEqual(readdirSync(dir), [`${NAME}.dpapi`]);
    assert.equal(await codeOf(store.load(NAME)), 'store_unavailable');
  });

  it('never creates the folder: setup makes it with its ACL, so a missing one is store_unavailable', async () => {
    const dir = path.join(root, 'never-made');
    const { store, log } = adapter(undefined, { dir });
    assert.equal(await codeOf(store.save(NAME, VALUE)), 'store_unavailable');
    assert.equal(existsSync(dir), false);
    assert.equal(log.spawns.length, 1, 'the helper ran, the write failed');
    assert.equal(await codeOf(store.load(NAME)), 'not_found');
    assert.equal((await store.status(NAME)).present, false);
    assert.equal(await store.erase(NAME), false);
  });

  it('a blob file that is empty or larger than any DPAPI blob of a 4 KiB value is unprotect_failed without starting the helper', async () => {
    const { dir, store, log } = adapter();
    writeFileSync(path.join(dir, `${NAME}.dpapi`), '');
    assert.equal(await codeOf(store.load(NAME)), 'unprotect_failed');
    writeFileSync(path.join(dir, `${NAME}.dpapi`), Buffer.alloc(SECRET_LIMITS.maxBlobBytes + 1, 7));
    assert.equal(await codeOf(store.load(NAME)), 'unprotect_failed');
    assert.equal((await store.verify(NAME)).readable, false);
    assert.equal(log.spawns.length, 0);
  });

  it('a blob made under another credential name does not open (the entropy differs), and the error is the same fixed code', async () => {
    const { dir, store } = adapter();
    await store.save(NAME, VALUE);
    writeFileSync(path.join(dir, `${API_NAME}.dpapi`), readFileSync(path.join(dir, `${NAME}.dpapi`)));
    assert.equal(await codeOf(store.load(API_NAME)), 'unprotect_failed');
    assert.deepEqual(await store.verify(API_NAME), { present: true, readable: false, sha256Prefix: null, savedAt: null });
  });

  it('a helper whose file or manifest does not match is never started', async () => {
    const dir = freshDir();
    const helper = scriptedHelper();
    const make = (helperPath, helperSha256) => createControlPlaneSecretStore({ secretsDir: dir, helperPath, helperSha256, spawnImpl: helper.spawnImpl });
    const tampered = makeHelper('original');
    const tamperedPin = pinned(tampered).helperSha256;
    writeFileSync(tampered, 'swapped'); // the file no longer matches its manifest, which still matches the pin
    const noManifest = makeHelper();
    rmSync(`${noManifest}.manifest.json`);
    const badManifest = makeHelper();
    writeFileSync(`${badManifest}.manifest.json`, JSON.stringify({ sha256: 'A'.repeat(64) }));
    const good = makeHelper('good');
    const otherBuild = makeHelper('another build'); // a healthy helper, but not the build the caller pinned
    const stores = [make(tampered, tamperedPin), make(noManifest, digestOf(DEFAULT_HELPER_TEXT)), make(badManifest, 'a'.repeat(64)), make(path.join(root, 'missing.exe'), 'a'.repeat(64)),
      make(otherBuild, pinned(good).helperSha256), make(good, 'b'.repeat(64))];
    for (const store of stores) {
      assert.equal(await codeOf(store.save(NAME, VALUE)), 'helper_unavailable');
      assert.equal(await codeOf(store.load(NAME)), 'not_found'); // no blob, so there is nothing to open
    }
    writeFileSync(path.join(dir, `${NAME}.dpapi`), 'x|y');
    for (const store of stores) assert.equal(await codeOf(store.load(NAME)), 'helper_unavailable');
    assert.equal(helper.log.spawns.length, 0);
    await make(good, digestOf('good')).save(NAME, VALUE);
    assert.equal(helper.log.spawns.length, 1, 'a pinned digest that matches starts it');
  });

  it('the helper and its pin are required: no default helper, no unpinned start, and a bad value is invalid_config up front', () => {
    const helperPath = makeHelper();
    const good = { secretsDir: root, ...pinned(helperPath) };
    assert.doesNotThrow(() => createControlPlaneSecretStore(good));
    const without = (key) => Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
    for (const bad of [{}, without('helperPath'), without('helperSha256'), without('secretsDir'), { ...good, helperSha256: null }, { ...good, helperSha256: undefined }, { ...good, helperPath: 'relative\\helper.exe' },
      { ...good, secretsDir: 'relative\\dir' }, { ...good, secretsDir: 7 }, { ...good, timeoutMs: 10 }, { ...good, timeoutMs: 1_000_000 }, { ...good, helperSha256: 'xyz' }, { ...good, helperSha256: 'A'.repeat(64) },
      { ...good, helperPath: 5 }, { ...good, now: 'today' }]) {
      assert.throws(() => createControlPlaneSecretStore(bad), (error) => error instanceof SecretStoreError && error.code === 'invalid_config');
    }
    assert.throws(() => createControlPlaneSecretStore(), (error) => error.code === 'invalid_config');
  });

  it('without a test seam, anything but Windows is unsupported_platform and nothing starts', { skip: process.platform === 'win32' }, async () => {
    const store = createControlPlaneSecretStore({ secretsDir: root, ...pinned(makeHelper()) });
    assert.equal(await codeOf(store.save(NAME, VALUE)), 'unsupported_platform');
  });

  it('a helper word passes through as itself, and only its own words do', async () => {
    for (const [word, exit] of [['invalid_request', 64], ['too_large', 64], ['protect_failed', 0], ['internal_error', 70]]) {
      const { store } = adapter(() => refusal(word, exit));
      assert.equal(await codeOf(store.save(NAME, VALUE)), word);
    }
    const { dir, store } = adapter(() => refusal('unprotect_failed', 0));
    writeFileSync(path.join(dir, `${NAME}.dpapi`), 'x|y');
    assert.equal(await codeOf(store.load(NAME)), 'unprotect_failed');
  });

  it('a reply that is not exactly the documented frame is invalid_response, with whatever text it carries kept out of the error', async () => {
    const TEXT = 'C:\\Users\\yosuke\\SECRET_MARKER';
    const blobFrame = replyFrame(0, 'a-blob');
    const cases = {
      'silence then exit 0': { reply: null, exit: 0 },
      'a frame cut short': { reply: blobFrame.subarray(0, blobFrame.length - 1), exit: 0 },
      'a frame with extra bytes': { reply: Buffer.concat([blobFrame, Buffer.from('x')]), exit: 0 },
      'a status byte that is neither': { reply: replyFrame(2, 'a-blob'), exit: 0 },
      'a success with no data': { reply: replyFrame(0, ''), exit: 0 },
      'a success with a failing exit code': { reply: blobFrame, exit: 70 },
      'a success with data above the bound': { reply: replyFrame(0, Buffer.alloc(SECRET_LIMITS.maxBlobBytes + 1, 1)), exit: 0 },
      'a refusal in words of its own': { reply: replyFrame(1, TEXT), exit: 0 },
      'a refusal with the wrong exit code': { reply: replyFrame(1, 'protect_failed'), exit: 64 },
      'a refusal with a word of the adapter': { reply: replyFrame(1, 'not_found'), exit: 0 },
      'a refusal built on an object property name': { reply: replyFrame(1, 'toString'), exit: 0 },
      'JSON text instead of a frame': { reply: Buffer.from(`{"ok":true,"note":"${TEXT}"}`), exit: 0 },
    };
    for (const [name, result] of Object.entries(cases)) {
      const { store } = adapter(() => result);
      const error = await failure(store.save(NAME, VALUE));
      assert.equal(error.code, 'invalid_response', name);
      assert.equal(JSON.stringify([error.message, error.code, String(error)]).includes('SECRET_MARKER'), false, name);
    }
  });

  it('a helper that sends more than a reply can hold is stopped', async () => {
    const { store, log } = adapter(() => ({ reply: Buffer.alloc(SECRET_LIMITS.maxBlobBytes + 64, 1), exit: 0 }));
    assert.equal(await codeOf(store.save(NAME, VALUE)), 'invalid_response');
    assert.equal(log.killed, 1);
  });

  it('a spawn that throws, or fails before it starts, is helper_unavailable; one that fails after it started is transport_error', async () => {
    const dir = freshDir();
    const helperPath = makeHelper();
    const store = (spawnImpl) => createControlPlaneSecretStore({ secretsDir: dir, ...pinned(helperPath), spawnImpl });
    assert.equal(await codeOf(store(() => { throw new Error('EACCES C:\\secret\\path'); }).save(NAME, VALUE)), 'helper_unavailable');
    const failing = (afterSpawn) => () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => { if (afterSpawn) child.emit('spawn'); setImmediate(() => child.emit('error', new Error('boom'))); });
      return child;
    };
    assert.equal(await codeOf(store(failing(false)).save(NAME, VALUE)), 'helper_unavailable');
    assert.equal(await codeOf(store(failing(true)).save(NAME, VALUE)), 'transport_error');
  });

  it('a helper that never answers is killed (its own child only) at the deadline and the call ends in timeout', async () => {
    const timers = mock.timers;
    timers.enable({ apis: ['setTimeout'] });
    try {
      const { store, log } = adapter(() => ({ hang: true }), { store: { timeoutMs: SECRET_LIMITS.minTimeoutMs } });
      const pending = store.save(NAME, VALUE);
      for (const limit = Date.now() + 5000; log.spawns.length === 0 && Date.now() < limit;) await new Promise((resolve) => setImmediate(resolve)); // setTimeout is the mocked clock here
      assert.equal(log.spawns.length, 1);
      timers.tick(SECRET_LIMITS.minTimeoutMs + 5000);
      assert.equal(await codeOf(pending), 'timeout');
      assert.equal(log.killed, 1);
    } finally { timers.reset(); }
  });

  it('wipes the buffers it owns: the request frame (it held the plaintext) and the reply that carried the plaintext back', async () => {
    const { store, log } = adapter();
    await store.save(NAME, VALUE);
    assert.ok(log.requests.length > 0 && log.requests.every((chunk) => chunk.every((byte) => byte === 0)), 'the protect request frame is zeroed');
    const loaded = await store.load(NAME);
    assert.equal(loaded.toString(), VALUE);
    const unprotectReply = log.replies.at(-1);
    assert.ok(unprotectReply.every((byte) => byte === 0), 'the reply frame of the unprotect is zeroed');
    assert.equal(loaded.toString(), VALUE, 'and the copy handed to the caller is intact');
  });
});

// ---- the helper source -------------------------------------------------------------------------------------------------------------------------------------------------------
describe('SecretMode.cs and its dispatch: source-level guards (any OS, no .NET SDK needed)', () => {
  const helperDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')), '..', 'src', 'runtime', 'windows-broker-pipe-client');
  const secretMode = readFileSync(path.join(helperDir, 'SecretMode.cs'), 'utf8');
  const code = secretMode.replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/\s.*$/gmu, '');
  const program = readFileSync(path.join(helperDir, 'Program.cs'), 'utf8');

  it('is small and reaches nothing: no pipe, no network, no file, no process, no stderr, no LOCAL_MACHINE scope', () => {
    assert.ok(secretMode.replace(/\n$/u, '').split('\n').length <= 160);
    for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /powershell/iu, /NamedPipe/u, /CreateFileW/u, /Socket/u, /HttpClient/u, /\bFile\./u, /\bDirectory\./u, /Console\.Error/u, /Console\.Write(Line)?\(/u,
      /Environment\.Exit/u, /LOCAL_MACHINE/u, /Impersonat/u]) {
      assert.equal(forbidden.test(code), false, `SecretMode.cs must not match ${forbidden}`);
    }
  });

  it('uses CurrentUser scope: the flags are UI_FORBIDDEN only, and the entropy is passed to both calls', () => {
    assert.match(code, /CryptUiForbidden = 0x1;/u);
    const calls = [...code.matchAll(/Crypt(?:Unp|P)rotectData\(ref input, IntPtr\.Zero, ref extra, IntPtr\.Zero, IntPtr\.Zero, CryptUiForbidden, out output\)/gu)];
    assert.equal(calls.length, 2);
    assert.equal(/\b0x4\b/u.test(code), false, 'CRYPTPROTECT_LOCAL_MACHINE (0x4) appears nowhere');
  });

  it('answers with the fixed words only, and wipes what held the plaintext', () => {
    const words = code.split('\n').filter((line) => line.includes('Refuse(')).flatMap((line) => [...line.matchAll(/"([a-z_]+)"/gu)].map((m) => m[1]));
    assert.ok(words.length > 0 && words.every((word) => ['invalid_request', 'too_large', 'protect_failed', 'unprotect_failed', 'internal_error'].includes(word)), `${[...new Set(words)]}`);
    assert.ok(words.includes('internal_error') && words.includes('unprotect_failed') && words.includes('too_large'));
    assert.ok([...code.matchAll(/CryptographicOperations\.ZeroMemory\(/gu)].length >= 3);
    assert.match(code, /Marshal\.Copy\(new byte\[output\.Size\], 0, output\.Data, output\.Size\);\s+_ = LocalFree\(output\.Data\);/u, 'the OS-owned output is zeroed before it is freed');
  });

  it('the three native imports resolve from System32 only', () => {
    const imports = code.split('\n').filter((line) => line.includes('[DllImport('));
    assert.equal(imports.length, 3);
    assert.ok(imports.every((line) => line.includes('DefaultDllImportSearchPaths(DllImportSearchPath.System32)')), 'every import carries the search-path attribute');
    assert.equal(/DllImportSearchPath\.(?!System32)/u.test(code), false);
  });

  it('the Node adapter names no helper path (the caller gives it, pinned), launches it from one site after the digest check, and has no shell, no direct pipe and no env value in a message', () => {
    const adapterText = readFileSync(path.join(helperDir, '..', 'control-plane-secret-store.mjs'), 'utf8');
    assert.equal(/windows-broker|bin[\\/]Release|arch-allow|fileURLToPath|DEFAULT_HELPER/iu.test(adapterText), false, 'no default helper and no repository build output');
    assert.match(adapterText, /manifest\.sha256 !== pinnedSha256\) throw/u, 'the pin is compared unconditionally');
    assert.equal(/pinnedSha256 !== null|helperSha256 = null|helperSha256 \?\?/u.test(adapterText), false, 'the pin is never optional');
    const order = ['await remove(metaOf(name));', 'await writeAtomic(file, blob);', 'await writeAtomic(metaOf(name)'].map((text) => adapterText.indexOf(text));
    assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], 'save: old meta removed, then the blob, then the new meta last');
    assert.deepEqual(adapterText.match(/^import .*child_process.*$/gmu), ["import { spawn } from 'node:child_process';"]);
    assert.equal(/node:net|\bexec\w*\(|\bfork\(|spawnSync|shell\s*:\s*true|console\.|process\.env/u.test(adapterText), false);
    assert.equal([...adapterText.matchAll(/spawnImpl \?\? spawn/gu)].length, 1, 'one launch site');
    assert.ok(adapterText.indexOf('await verifyHelper(helperPath, helperSha256);') < adapterText.indexOf('return runHelper(spawnImpl ?? spawn'), 'the digest is verified before the helper is launched');
  });

  it('is chosen by one exact argument and the older modes keep theirs', () => {
    assert.match(program, /args is \["secret"\]\) return RunSecret\(\);/u);
    assert.match(program, /args is \["desktop"\]/u);
    assert.ok(program.replace(/\n$/u, '').split('\n').length <= 270);
  });
});
