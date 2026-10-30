import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sendBrokerRequest } from '../src/runtime/windows-broker-client.mjs';
import {
  buildBroker, buildBrokerWithTestSeams, buildPipeClient, currentUserSid, getUnavailableReason, inspectClaimCount, makeReceipt,
  makeTrustedTempDirectory, startBroker, startProcess, waitForExit, waitForLine, GENERATION,
} from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged (issue #84, decision-log row 2026-10-30+broker-journal-parity). The parts of the Node broker contract that do
// not depend on the receipt format, checked against the .NET Broker's SQLite journal:
//   1. schema version (PRAGMA user_version) and the forward migration from the unversioned journal of #22 / #23; a newer or unknown journal is refused;
//   2. an exact duplicate (same receipt bytes and signature) gets the recorded outcome, anything else that collides stays denied;
//   3. the fixed `synthetic.inspect` action reads the recorded state and writes nothing.
// Nothing here registers or starts a service. The serve loop is the seam build's `serve-loop` (end of stdin plays STOP); `serve` is the shipped one-shot.
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const DENIED = { ok: false, code: 'denied' };
const EXIT_JOURNAL_REFUSED = 76;
const INSPECT = 'synthetic.inspect';
const LEGACY_SQL = 'CREATE TABLE claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL);';
const CURRENT_COLUMNS = ['operation_id', 'receipt_id', 'approval_id', 'digest', 'lease_generation', 'state', 'request_digest'];

describe('Broker journal: schema version and migration, exact duplicate, inspect', { skip: getUnavailableReason() }, () => {
  let root, brokerExe, loopExe, helper, sid, keys;
  const running = new Set();
  before(async () => {
    root = makeTrustedTempDirectory('albera-journal-'); // long form, DACL = this user + SYSTEM only (the trusted baseline the service host demands)
    brokerExe = buildBroker(path.join(root, 'broker'));
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    keys = { privateKey, publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
  });
  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const track = (child) => { running.add(child); child.once('close', () => running.delete(child)); return child; };
  const unique = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
  const signBytes = (receipt) => sign('sha256', Buffer.from(receipt, 'base64'), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  /** A claim receipt signed by the test authority (ECDSA signatures are randomized: signing the same receipt twice gives two different signatures). */
  const claimOf = (name, overrides) => { const receipt = makeReceipt(`${name}-op`, `${name}-approval`, `${name}-receipt`, overrides); return { receipt, signature: signBytes(receipt) }; };
  /** An inspect receipt for `operationId`: same twelve fields, action `synthetic.inspect`, its own approvalId / receiptId. */
  const inspectOf = (operationId, name, overrides) => {
    const receipt = makeReceipt(operationId, `${name}-approval`, `${name}-receipt`, { action: INSPECT, ...overrides });
    return { receipt, signature: signBytes(receipt) };
  };

  async function send(pipe, request, brokerPid) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await sendBrokerRequest({ pipeName: pipe, receipt: request.receipt, signature: request.signature, expect: { ownerSid: sid, pid: brokerPid }, helperPath: helper, timeoutMs: 10_000 });
      if (result.code !== 'broker_unavailable' || attempt >= 40) return result; // between two requests the instance is busy: pre-send, safe to retry
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  let scenarios = 0;
  /** A fresh folder under the trusted root with a `db` sub-folder and a written config. `prepare(databasePath)` may create the journal first. */
  function scenario(name, prepare) {
    const dir = path.join(root, `${name}-${(scenarios += 1)}`);
    mkdirSync(dir);
    mkdirSync(path.join(dir, 'db'));
    const database = path.join(dir, 'db', 'journal.sqlite');
    prepare?.(database);
    const configFile = path.join(dir, 'config.json');
    const config = { pipeName: unique('ALBERA_Journal'), database, publicKey: keys.publicKeyB64, controlPlaneSid: sid, generation: GENERATION };
    writeFileSync(configFile, JSON.stringify(config));
    return { ...config, configFile };
  }
  const startLoop = (s, hold) => track(startProcess(loopExe, ['serve-loop', s.configFile, ...(hold ? [String(hold)] : [])], { stdin: true }));
  async function stop(child) { child.stdin.end(); return waitForExit(child); }

  /** Create a journal with `statements` (run once, in the default rollback-journal mode), then close it. */
  function makeJournal(database, ...statements) {
    const db = new DatabaseSync(database);
    for (const statement of statements) db.exec(statement);
    db.close();
  }
  const legacy = (...rows) => (database) => makeJournal(database, LEGACY_SQL, ...rows.map(([op, receipt, approval]) =>
    `INSERT INTO claims VALUES ('${op}', '${receipt}', '${approval}', 'LEGACYDIGEST', ${GENERATION}, 'UNKNOWN');`));
  /** Everything a reader can see: the version, the columns and every row. Opened read-only, so reading it cannot change the journal. */
  function snapshot(database) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      return {
        version: db.prepare('PRAGMA user_version').get().user_version,
        columns: db.prepare("SELECT name FROM pragma_table_info('claims') ORDER BY cid").all().map((row) => row.name),
        rows: db.prepare('SELECT * FROM claims ORDER BY operation_id').all().map((row) => ({ ...row })),
      };
    } finally { db.close(); }
  }
  const setVersion = (database, version) => makeJournal(database, `PRAGMA user_version = ${version};`);
  const fileHash = (database) => createHash('sha256').update(readFileSync(database)).digest('hex');
  const requestDigest = ({ receipt, signature }) => {
    const bytes = Buffer.from(receipt, 'base64'), length = Buffer.alloc(4);
    length.writeInt32LE(bytes.length);
    return createHash('sha256').update(Buffer.concat([length, bytes, Buffer.from(signature, 'base64')])).digest('hex').toUpperCase();
  };

  describe('schema version and forward migration', () => {
    it('a new journal is created at version 2 and stores the digest of the exact receipt bytes and signature', async () => {
      const s = scenario('fresh');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.equal(existsSync(s.database), false, 'start-up creates nothing: the first claim does');
      const request = claimOf('fresh');
      assert.deepEqual(await send(s.pipeName, request, child.pid), SUCCESS);
      assert.equal(await stop(child), 0);
      const { version, columns, rows } = snapshot(s.database);
      assert.deepEqual([version, columns], [2, CURRENT_COLUMNS]);
      assert.deepEqual(rows.map(({ operation_id: op, state, request_digest: digest }) => [op, state, digest]), [['fresh-op', 'UNKNOWN', requestDigest(request)]]);
    });

    it('an unversioned journal of #22 / #23 is migrated at start-up, before the first request: rows kept, digest NULL, version 2', async () => {
      const s = scenario('migrate', legacy(['old-op', 'old-receipt', 'old-approval'], ['older-op', 'older-receipt', 'older-approval']));
      const before = snapshot(s.database);
      assert.deepEqual([before.version, before.columns.length], [0, 6]);
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const migrated = snapshot(s.database);
      assert.deepEqual([migrated.version, migrated.columns], [2, CURRENT_COLUMNS], 'migrated before RUNNING, with no request sent');
      assert.deepEqual(migrated.rows.map((row) => ({ ...row, request_digest: undefined })), before.rows.map((row) => ({ ...row, request_digest: undefined })), 'every old row is unchanged');
      assert.deepEqual(migrated.rows.map((row) => row.request_digest), [null, null]);
      // The migrated journal keeps working: a new claim lands, and the old operations answer as claimed.
      assert.deepEqual(await send(s.pipeName, claimOf('after-migration'), child.pid), SUCCESS);
      assert.deepEqual(await send(s.pipeName, inspectOf('old-op', 'inspect-old'), child.pid), SUCCESS, 'a migrated row can be inspected');
      assert.equal(await stop(child), 0);
      assert.equal(snapshot(s.database).rows.length, 3);
      assert.equal(inspectClaimCount(brokerExe, s.database), 3);
    });

    it('a migrated row stored no digest, so it can never be proven an exact duplicate: a new receipt for it stays denied', async () => {
      const s = scenario('migrate-dup', legacy(['old-op', 'old-receipt', 'old-approval']));
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(await send(s.pipeName, claimOf('old'), child.pid), DENIED, 'same operationId, receiptId and approvalId as the old row');
      assert.ok(child.lines.includes('DENY=duplicate'), child.lines.join('|'));
      assert.equal(await stop(child), 0);
      assert.equal(snapshot(s.database).rows.length, 1);
    });

    it('the shipped one-shot `serve` migrates too, and serves one request on the migrated journal', async () => {
      const s = scenario('migrate-serve', legacy(['old-op', 'old-receipt', 'old-approval']));
      const broker = track(startBroker(brokerExe, s.pipeName, s.database, s.publicKey, sid, GENERATION));
      await waitForLine(broker, 'BROKER_READY');
      assert.equal(snapshot(s.database).version, 2);
      assert.deepEqual(await send(s.pipeName, claimOf('serve-new'), broker.pid), SUCCESS);
      assert.equal(await waitForExit(broker), 0);
      assert.equal(inspectClaimCount(brokerExe, s.database), 2);
    });

    // [label, how to build the journal, reason word]. Each is refused before the pipe exists, with 76, and the file is not touched.
    const refused = [
      ['a journal written by a newer Broker (version 3)', (db) => { makeJournal(db, LEGACY_SQL, 'PRAGMA user_version = 3;'); }, 'NEWER'],
      ['a far-future version', (db) => { makeJournal(db, LEGACY_SQL, 'PRAGMA user_version = 99;'); }, 'NEWER'],
      ['version 1, which no Broker ever wrote', (db) => { makeJournal(db, LEGACY_SQL, 'PRAGMA user_version = 1;'); }, 'UNSUPPORTED'],
      ['version 0 with a table that is not the legacy claims table', (db) => { makeJournal(db, 'CREATE TABLE something_else (x TEXT);'); }, 'UNSUPPORTED'],
      ['version 0 with the claims table plus another table', (db) => { makeJournal(db, LEGACY_SQL, 'CREATE TABLE extra (x TEXT);'); }, 'UNSUPPORTED'],
      ['version 0 with a claims table of other columns', (db) => { makeJournal(db, 'CREATE TABLE claims (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL);'); }, 'UNSUPPORTED'],
      ['version 2 whose claims table lost a column', (db) => { makeJournal(db, 'CREATE TABLE claims (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL);', 'PRAGMA user_version = 2;'); }, 'UNSUPPORTED'],
      ['a file that is not a SQLite database', (db) => { writeFileSync(db, 'not a database. '.repeat(512)); }, 'UNREADABLE'],
    ];
    for (const [label, build, reason] of refused) {
      it(`refuses ${label}: serve-loop exits 76, names JOURNAL_${reason}, creates no pipe and leaves the file byte-identical`, async () => {
        const s = scenario('refused', build);
        const hashBefore = fileHash(s.database);
        const child = startLoop(s);
        assert.equal(await waitForExit(child), EXIT_JOURNAL_REFUSED, child.lines.join('|'));
        assert.deepEqual(child.lines, [`BROKER_FATAL=JOURNAL_${reason}`, 'BROKER_STOPPED']);
        assert.equal(fileHash(s.database), hashBefore, 'a refused journal is never changed, not even by a journal_mode switch');
        assert.equal(existsSync(`${s.database}-wal`), false);
      });
    }

    it('the shipped one-shot `serve` refuses a newer journal with 76 before the pipe exists', async () => {
      const s = scenario('refused-serve', (db) => makeJournal(db, LEGACY_SQL, 'PRAGMA user_version = 3;'));
      const hashBefore = fileHash(s.database);
      const broker = track(startBroker(brokerExe, s.pipeName, s.database, s.publicKey, sid, GENERATION));
      assert.equal(await waitForExit(broker), EXIT_JOURNAL_REFUSED, broker.lines.join('|'));
      assert.deepEqual(broker.lines, ['BROKER_FATAL=JOURNAL_NEWER']);
      assert.equal(fileHash(s.database), hashBefore);
    });

    it('a journal that turns newer while the service runs is refused per request (claim and inspect denied, nothing written) and works again once restored', async () => {
      const s = scenario('turns-newer');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(await send(s.pipeName, claimOf('before'), child.pid), SUCCESS);
      setVersion(s.database, 3);
      assert.deepEqual(await send(s.pipeName, claimOf('during'), child.pid), DENIED);
      assert.deepEqual(await send(s.pipeName, inspectOf('before-op', 'during-inspect'), child.pid), DENIED);
      assert.equal(child.closeCode, undefined, 'still running');
      assert.equal(child.lines.filter((line) => line === 'REQUEST=DENIED').length, 2);
      assert.deepEqual(snapshot(s.database).rows.map((row) => row.operation_id), ['before-op']);
      setVersion(s.database, 2);
      assert.deepEqual(await send(s.pipeName, claimOf('after'), child.pid), SUCCESS);
      assert.equal(await stop(child), 0);
      assert.deepEqual(snapshot(s.database).rows.map((row) => row.operation_id), ['after-op', 'before-op']);
    });
  });

  describe('exact duplicate returns the recorded outcome', () => {
    it('the same receipt bytes and signature get the recorded outcome and write nothing; every other collision stays denied', async () => {
      const s = scenario('duplicate');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const first = claimOf('dup');
      assert.deepEqual(await send(s.pipeName, first, child.pid), SUCCESS);
      const afterFirst = snapshot(s.database);
      assert.equal(afterFirst.rows.length, 1);

      assert.deepEqual(await send(s.pipeName, first, child.pid), SUCCESS, 'exact duplicate');
      assert.deepEqual(await send(s.pipeName, { ...first }, child.pid), SUCCESS, 'and again');
      assert.equal(child.lines.filter((line) => line === 'REPLAY=RECORDED_OUTCOME').length, 2);
      assert.equal(child.lines.filter((line) => line === 'CLAIM=PERSISTED_UNKNOWN').length, 1, 'one claim only');
      assert.deepEqual(snapshot(s.database), afterFirst, 'a replay changes no row');

      const resigned = { receipt: first.receipt, signature: signBytes(first.receipt) };
      assert.notEqual(resigned.signature, first.signature);
      assert.deepEqual(await send(s.pipeName, resigned, child.pid), DENIED, 'same receipt bytes, different signature: not an exact duplicate');
      const otherReceipt = claimOf('dup', { idempotencyKey: 'another-key' });
      assert.deepEqual(await send(s.pipeName, otherReceipt, child.pid), DENIED, 'a different receipt for the same operationId');
      const reusedIds = claimOf('dup-other', { receiptId: 'dup-receipt' });
      assert.deepEqual(await send(s.pipeName, reusedIds, child.pid), DENIED, 'another operation reusing the receiptId');
      const reusedApproval = claimOf('dup-third', { approvalId: 'dup-approval' });
      assert.deepEqual(await send(s.pipeName, reusedApproval, child.pid), DENIED, 'another operation reusing the approvalId');
      assert.equal(child.lines.filter((line) => line === 'DENY=duplicate').length, 4);
      assert.equal(await stop(child), 0);
      assert.deepEqual(snapshot(s.database), afterFirst, 'no denied request left a row');
    });

    it('a replay never bypasses the receipt checks: an exact duplicate whose receipt has expired is denied', async () => {
      const s = scenario('duplicate-expiry');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const shortLived = claimOf('short', { expiresAt: Math.floor(Date.now() / 1000) + 3 });
      assert.deepEqual(await send(s.pipeName, shortLived, child.pid), SUCCESS);
      assert.deepEqual(await send(s.pipeName, shortLived, child.pid), SUCCESS, 'still within the lifetime: the recorded outcome');
      await new Promise((resolve) => setTimeout(resolve, 3500));
      assert.deepEqual(await send(s.pipeName, shortLived, child.pid), DENIED, 'expired');
      assert.ok(child.lines.includes('DENY=receipt-policy'));
      assert.equal(await stop(child), 0);
      assert.equal(snapshot(s.database).rows.length, 1);
    });

    it('after a crash that lost the reply, the restarted Broker answers the exact duplicate from the journal and never claims twice', async () => {
      const s = scenario('duplicate-crash');
      const held = startLoop(s, 60_000); // the claim is committed, then the answer is held back
      await waitForLine(held, 'BROKER_READY');
      const request = claimOf('crash');
      const lost = send(s.pipeName, request, held.pid).catch(() => undefined);
      await waitForLine(held, 'CLAIM=PERSISTED_UNKNOWN');
      held.kill();
      await waitForExit(held);
      await lost;
      const restarted = startLoop(s);
      await waitForLine(restarted, 'BROKER_READY');
      assert.deepEqual(await send(s.pipeName, request, restarted.pid), SUCCESS);
      assert.ok(restarted.lines.includes('REPLAY=RECORDED_OUTCOME') && !restarted.lines.includes('CLAIM=PERSISTED_UNKNOWN'), restarted.lines.join('|'));
      assert.equal(await stop(restarted), 0);
      assert.equal(snapshot(s.database).rows.length, 1);
    });
  });

  describe('fixed inspect action (synthetic.inspect)', () => {
    it('returns the recorded state of a claimed operation, in the unchanged success shape, and changes nothing', async () => {
      const s = scenario('inspect');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(await send(s.pipeName, claimOf('target'), child.pid), SUCCESS);
      const before = snapshot(s.database);
      const request = inspectOf('target-op', 'look');
      assert.deepEqual(await send(s.pipeName, request, child.pid), SUCCESS);
      assert.deepEqual(await send(s.pipeName, request, child.pid), SUCCESS, 'an inspect receipt is not single-use: it reads and consumes nothing');
      assert.equal(child.lines.filter((line) => line === 'INSPECT=RECORDED').length, 2);
      assert.equal(child.lines.filter((line) => line === 'CLAIM=PERSISTED_UNKNOWN').length, 1);
      assert.deepEqual(snapshot(s.database), before, 'no row, no version change');
      // The inspect receipt's own ids were not recorded: another operation can still be claimed with them.
      assert.deepEqual(await send(s.pipeName, claimOf('other', { approvalId: 'look-approval', receiptId: 'look-receipt' }), child.pid), SUCCESS);
      assert.equal(await stop(child), 0);
      assert.equal(snapshot(s.database).rows.length, 2);
    });

    it('answers for an operation claimed before a crash whose reply was lost (the reconcile read), also after a restart', async () => {
      const s = scenario('inspect-crash');
      const held = startLoop(s, 60_000);
      await waitForLine(held, 'BROKER_READY');
      const lost = send(s.pipeName, claimOf('lost'), held.pid).catch(() => undefined);
      await waitForLine(held, 'CLAIM=PERSISTED_UNKNOWN');
      held.kill();
      await waitForExit(held);
      await lost;
      const restarted = startLoop(s);
      await waitForLine(restarted, 'BROKER_READY');
      assert.deepEqual(await send(s.pipeName, inspectOf('lost-op', 'reconcile'), restarted.pid), SUCCESS);
      assert.deepEqual(await send(s.pipeName, inspectOf('never-claimed-op', 'reconcile-none'), restarted.pid), DENIED, 'no record: denied, nothing created');
      assert.equal(await stop(restarted), 0);
      assert.equal(snapshot(s.database).rows.length, 1);
    });

    it('an unknown operation is denied without a row, and with no journal file at all nothing is created', async () => {
      const s = scenario('inspect-none');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(await send(s.pipeName, inspectOf('ghost-op', 'ghost'), child.pid), DENIED);
      assert.equal(existsSync(s.database), false, 'inspect never creates the journal');
      assert.deepEqual(await send(s.pipeName, claimOf('real'), child.pid), SUCCESS);
      assert.deepEqual(await send(s.pipeName, inspectOf('ghost-op', 'ghost-2'), child.pid), DENIED);
      assert.equal(child.lines.filter((line) => line === 'DENY=inspect-unknown').length, 2);
      assert.equal(await stop(child), 0);
      assert.deepEqual(snapshot(s.database).rows.map((row) => row.operation_id), ['real-op']);
    });

    it('goes through the same checks as a claim: tampered, expired, stale-generation, wrong-digest and unsigned inspect receipts are denied', async () => {
      const s = scenario('inspect-checks');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(await send(s.pipeName, claimOf('guarded'), child.pid), SUCCESS);
      const before = snapshot(s.database);
      const good = inspectOf('guarded-op', 'checks');
      assert.deepEqual(await send(s.pipeName, good, child.pid), SUCCESS, 'control');
      const edited = Buffer.from(Buffer.from(good.receipt, 'base64').toString('utf8').replace('guarded-op', 'other-op')).toString('base64');
      for (const [label, request] of [
        ['signature over other bytes', { receipt: edited, signature: good.signature }],
        ['expired', inspectOf('guarded-op', 'expired', { expiresAt: 1 })],
        ['stale generation', inspectOf('guarded-op', 'stale', { leaseGeneration: GENERATION - 1 })],
        ['digest of another action', inspectOf('guarded-op', 'digest', { actionDigest: createHash('sha256').update('synthetic.noop').digest('hex').toUpperCase() })],
        ['an action that is not on the allowlist', inspectOf('guarded-op', 'other-action', { action: 'synthetic.reconcile', actionDigest: createHash('sha256').update('synthetic.reconcile').digest('hex').toUpperCase() })],
        ['signed by another key', (() => {
          const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
          const receipt = makeReceipt('guarded-op', 'foreign-approval', 'foreign-receipt', { action: INSPECT });
          return { receipt, signature: sign('sha256', Buffer.from(receipt, 'base64'), { key: other, dsaEncoding: 'ieee-p1363' }).toString('base64') };
        })()],
      ]) assert.deepEqual(await send(s.pipeName, request, child.pid), DENIED, label);
      assert.equal(child.closeCode, undefined);
      assert.equal(await stop(child), 0);
      assert.deepEqual(snapshot(s.database), before);
    });
  });
});
