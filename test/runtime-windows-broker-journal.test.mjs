import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  brokerSession, buildBroker, buildBrokerWithTestSeams, buildPipeClient, createTestAuthority, currentUserSid, getUnavailableReason, inspectClaimCount,
  makeTrustedTempDirectory, standInService, startBroker, startProcess, stableUuid, waitForExit, waitForLine, GENERATION, LEASE_CONFIG,
} from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged (issue #84, decision-log rows 2026-10-30+broker-journal-parity and 2026-10-30+broker-receipt-v2). The journal of the
// .NET Broker, checked through the real pipe client helper:
//   1. schema version (PRAGMA user_version = 3), the exact CREATE statements, and the forward migration from the unversioned journal of #22 / #23 and
//      from version 2; a newer or unknown journal is refused;
//   2. an exact duplicate (same receipt bytes and signature) gets the recorded outcome (`replayed: true`), anything else that collides stays denied;
//   3. the read-only `inspect` request reads the recorded state and writes nothing;
//   4. restoring a backup of the journal: there is no restore-specific mechanism, the start-up epoch bump that deletes every challenge IS the restore fence.
// Nothing here registers or starts a service. The serve loop is the seam build's `serve-loop` (end of stdin plays STOP); `serve` is the shipped one-shot.
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const REPLAYED = { ...SUCCESS, replayed: true };
const INSPECTED = { ok: true, state: 'UNKNOWN', action: 'synthetic.inspect' };
const DENIED = { ok: false, code: 'denied' };
const EXIT_JOURNAL_REFUSED = 76;
const LEGACY_SQL = 'CREATE TABLE claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL);';
const DIGEST_COLUMN = 'request_digest TEXT CHECK(request_digest IS NULL OR length(request_digest) = 64)';
const VERSION_2_SQL = `CREATE TABLE claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL, ${DIGEST_COLUMN});`;
const CURRENT_COLUMNS = ['operation_id', 'receipt_id', 'approval_id', 'digest', 'lease_generation', 'state', 'request_digest'];
const CURRENT_TABLES = ['broker_state', 'challenges', 'claims'];

describe('Broker journal: schema version and migration, exact duplicate, inspect', { skip: getUnavailableReason() }, () => {
  let root, brokerExe, loopExe, helper, sid, authority;
  const running = new Set();
  before(async () => {
    root = makeTrustedTempDirectory('albera-journal-'); // long form, DACL = this user + SYSTEM only (the trusted baseline the service host demands)
    brokerExe = buildBroker(path.join(root, 'broker'));
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
    authority = createTestAuthority();
  });
  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const track = (child) => { running.add(child); child.once('close', () => running.delete(child)); return child; };
  const unique = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
  /** The Control Plane side of one running Broker: fence, sign with the test authority, send. */
  const sessionOf = (s, child) => brokerSession({ helper, sid, pipeName: s.pipeName, pid: child.pid, authority });

  let scenarios = 0;
  /** A fresh folder under the trusted root with a `db` sub-folder and a written config. `prepare(databasePath)` may create the journal first. */
  function scenario(name, prepare, generation = GENERATION) {
    const dir = path.join(root, `${name}-${(scenarios += 1)}`);
    mkdirSync(dir);
    mkdirSync(path.join(dir, 'db'));
    const database = path.join(dir, 'db', 'journal.sqlite');
    prepare?.(database);
    const configFile = path.join(dir, 'config.json');
    const config = { pipeName: unique('ALBERA_Journal'), database, authorityKeys: [authority.keyEntry], controlPlaneSid: sid, generation, ...LEASE_CONFIG };
    writeFileSync(configFile, JSON.stringify(config));
    return { ...config, configFile };
  }
  const startLoop = (s, hold) => track(startProcess(loopExe, standInService('serve-loop', s.configFile, ...(hold ? [String(hold)] : [])), { stdin: true }));
  async function stop(child) { child.stdin.end(); return waitForExit(child); }

  /** Create a journal with `statements` (run once, in the default rollback-journal mode), then close it. */
  function makeJournal(database, ...statements) {
    const db = new DatabaseSync(database);
    for (const statement of statements) db.exec(statement);
    db.close();
  }
  const legacy = (...rows) => (database) => makeJournal(database, LEGACY_SQL, ...rows.map(([op, receipt, approval]) =>
    `INSERT INTO claims VALUES ('${op}', '${receipt}', '${approval}', 'LEGACYDIGEST', ${GENERATION}, 'UNKNOWN');`));
  const digest64 = 'A'.repeat(64);
  const version2 = (...rows) => (database) => makeJournal(database, VERSION_2_SQL, 'PRAGMA user_version = 2;', ...rows.map(([op, receipt, approval]) =>
    `INSERT INTO claims VALUES ('${op}', '${receipt}', '${approval}', 'V2DIGEST', ${GENERATION}, 'UNKNOWN', '${digest64}');`));
  /** The claims table as a reader sees it: the version, the columns and every row. Opened read-only, so reading it cannot change the journal. */
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
  /** The Broker-owned fence state and the challenges, as stored. */
  function fenceRows(database) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      return {
        tables: db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
        state: { ...db.prepare('SELECT epoch, lease_generation FROM broker_state').get() },
        clockHighWater: db.prepare('SELECT clock_high_water AS hw FROM broker_state').get().hw,
        challenges: db.prepare('SELECT challenge, epoch, lease_generation, computer_id, state FROM challenges ORDER BY rowid').all().map((row) => ({ ...row })),
      };
    } finally { db.close(); }
  }
  const JOURNAL_SUFFIXES = ['', '-wal', '-shm'];
  /** Copy a STOPPED Broker's journal (the database plus its -wal / -shm if they exist) to `to`. */
  const copyJournal = (from, to) => { for (const suffix of JOURNAL_SUFFIXES) if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix); };
  /** Put a backup back in place of the journal: the current files go first, so no stale -wal / -shm survives the restore. */
  const restoreJournal = (backup, database) => { for (const suffix of JOURNAL_SUFFIXES) rmSync(database + suffix, { force: true }); copyJournal(backup, database); };
  const writeConfig = (s, changes) => writeFileSync(s.configFile, JSON.stringify({ ...JSON.parse(readFileSync(s.configFile, 'utf8')), ...changes }));
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  /** fenceRows without the clock mark, which a start and every fence move to the Broker's clock. */
  const fenceView = (database) => { const { clockHighWater, ...rest } = fenceRows(database); return rest; };
  const setVersion = (database, version) => makeJournal(database, `PRAGMA user_version = ${version};`);
  const fileHash = (database) => createHash('sha256').update(readFileSync(database)).digest('hex');
  const requestDigest = ({ receipt, signature }) => {
    const bytes = Buffer.from(receipt, 'base64'), length = Buffer.alloc(4);
    length.writeInt32LE(bytes.length);
    return createHash('sha256').update(Buffer.concat([length, bytes, Buffer.from(signature, 'base64')])).digest('hex').toUpperCase();
  };

  describe('schema version and forward migration', () => {
    it('a new journal is created at version 3 when the Broker starts (epoch 1, the configured generation) and stores the digest of the exact receipt bytes and signature', async () => {
      const s = scenario('fresh');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.equal(existsSync(s.database), true, 'the new epoch is written before RUNNING, so the journal exists at start-up');
      assert.deepEqual(fenceView(s.database), { tables: CURRENT_TABLES, state: { epoch: 1, lease_generation: GENERATION }, challenges: [] });
      assert.ok(Math.abs(fenceRows(s.database).clockHighWater - nowSeconds()) <= 5, 'the start raised the clock mark to the Broker\'s clock, before any claim');
      assert.equal(snapshot(s.database).rows.length, 0, 'no claim yet');
      const session = sessionOf(s, child);
      const { request, result } = await session.claim('fresh');
      assert.deepEqual(result, SUCCESS);
      assert.equal(await stop(child), 0);
      const { version, columns, rows } = snapshot(s.database);
      assert.deepEqual([version, columns], [3, CURRENT_COLUMNS]);
      assert.deepEqual(rows.map(({ operation_id: op, state, request_digest: digest }) => [op, state, digest]), [['fresh-op', 'UNKNOWN', requestDigest(request)]]);
      assert.equal(fenceRows(s.database).clockHighWater, JSON.parse(Buffer.from(request.receipt, 'base64')).iat, 'the high-water mark is the iat of the accepted claim');
    });

    it('an unversioned journal of #22 / #23 is migrated at start-up, before the first request: rows kept, digest NULL, version 3, generation from the config', async () => {
      const s = scenario('migrate', legacy(['old-op', 'old-receipt', 'old-approval'], ['older-op', 'older-receipt', 'older-approval']), 9);
      const before = snapshot(s.database);
      assert.deepEqual([before.version, before.columns.length], [0, 6]);
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const migrated = snapshot(s.database);
      assert.deepEqual([migrated.version, migrated.columns], [3, CURRENT_COLUMNS], 'migrated before RUNNING, with no request sent');
      assert.deepEqual(migrated.rows.map((row) => ({ ...row, request_digest: undefined })), before.rows.map((row) => ({ ...row, request_digest: undefined })), 'every old row is unchanged');
      assert.deepEqual(migrated.rows.map((row) => row.request_digest), [null, null]);
      assert.deepEqual(fenceRows(s.database).state, { epoch: 1, lease_generation: 9 }, 'the configured generation is the initial value of a journal that had none');
      // The migrated journal keeps working: a new claim lands, and the old operations answer as claimed.
      const session = sessionOf(s, child);
      assert.deepEqual((await session.claim('after-migration')).result, SUCCESS);
      assert.deepEqual(await session.inspect('old-op'), INSPECTED, 'a migrated row can be inspected');
      assert.equal(await stop(child), 0);
      assert.equal(snapshot(s.database).rows.length, 3);
      assert.equal(inspectClaimCount(brokerExe, s.database), 3);
    });

    it('a version 2 journal (claims with request_digest, no fence tables) is migrated to 3 with its digests kept; a version 2 journal that the previous Broker migrated from the unversioned one is accepted too', async () => {
      const plain = scenario('migrate-v2', version2(['v2-op', 'v2-receipt', 'v2-approval']));
      const child = startLoop(plain);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(snapshot(plain.database).rows.map((row) => [row.operation_id, row.request_digest]), [['v2-op', digest64]]);
      assert.deepEqual(fenceView(plain.database), { tables: CURRENT_TABLES, state: { epoch: 1, lease_generation: GENERATION }, challenges: [] });
      assert.equal(snapshot(plain.database).version, 3);
      assert.equal(await stop(child), 0);

      // The previous Broker migrated with ALTER TABLE: SQLite stores a different (appended) CREATE text for that table, which is a known shape.
      const altered = scenario('migrate-v2-altered', (database) => makeJournal(database, LEGACY_SQL, `ALTER TABLE claims ADD COLUMN ${DIGEST_COLUMN};`, 'PRAGMA user_version = 2;'));
      const second = startLoop(altered);
      await waitForLine(second, 'BROKER_READY');
      assert.equal(snapshot(altered.database).version, 3);
      assert.equal(await stop(second), 0);
    });

    it('a migrated row stored no digest, so it can never be proven an exact duplicate: a new receipt for it stays denied', async () => {
      const s = scenario('migrate-dup', legacy(['old-op', 'old-receipt', 'old-approval']));
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const { result } = await sessionOf(s, child).claim('old', { receiptId: stableUuid('anything'), approvalId: stableUuid('else') });
      assert.deepEqual(result, DENIED, 'same operationId as the old row');
      assert.ok(child.lines.includes('DENY=duplicate'), child.lines.join('|'));
      assert.equal(await stop(child), 0);
      assert.equal(snapshot(s.database).rows.length, 1);
    });

    it('the shipped one-shot `serve` migrates too, and serves a fence and the claim that follows on the migrated journal', async () => {
      const s = scenario('migrate-serve', legacy(['old-op', 'old-receipt', 'old-approval']));
      const broker = track(startBroker(brokerExe, s.pipeName, s.database, authority.serveArgument, sid, GENERATION));
      await waitForLine(broker, 'BROKER_READY');
      assert.equal(snapshot(s.database).version, 3);
      const { result } = await sessionOf(s, broker).claim('serve-new');
      assert.deepEqual(result, SUCCESS);
      assert.equal(await waitForExit(broker), 0);
      assert.equal(inspectClaimCount(brokerExe, s.database), 2);
    });

    it('the configured generation is reconciled at every start: higher advances the journal (the old generation is revoked), equal changes nothing', async () => {
      const s = scenario('generation-advance');
      let child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      let session = sessionOf(s, child);
      const old = await session.prepare('before-advance'); // a receipt for generation 7, signed against a live challenge
      assert.equal(old.fence.leaseGeneration, GENERATION);
      assert.equal(await stop(child), 0);

      // Equal: a new epoch and nothing else.
      child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(fenceView(s.database).state, { epoch: 2, lease_generation: GENERATION });
      assert.equal(await stop(child), 0);

      // Higher: the operator configures N+1 and restarts.
      writeFileSync(s.configFile, JSON.stringify({ ...JSON.parse(readFileSync(s.configFile, 'utf8')), generation: GENERATION + 1 }));
      child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(fenceView(s.database).state, { epoch: 3, lease_generation: GENERATION + 1 });
      session = sessionOf(s, child);
      assert.deepEqual(await session.send(old), DENIED, 'a receipt for generation N is dead');
      assert.equal(child.lines.includes('DENY=challenge_unknown') || child.lines.includes('DENY=generation_stale'), true, child.lines.join('|'));
      const fresh = await session.fence();
      assert.equal(fresh.leaseGeneration, GENERATION + 1);
      const stale = await session.claim('stale-after-advance', (fence) => ({ leaseGeneration: fence.leaseGeneration - 1 }));
      assert.deepEqual(stale.result, DENIED);
      assert.equal(child.lines.filter((line) => line === 'DENY=generation_stale').length, 1, 'a receipt that still says N against a live N+1 challenge is generation_stale');
      assert.deepEqual((await session.claim('accepted-after-advance')).result, SUCCESS, 'N+1 is accepted');
      assert.equal(await stop(child), 0);
    });

    it('a configured generation below the journal\'s refuses the start (76, JOURNAL_GENERATION_REGRESSED) with no pipe and the journal untouched; serve refuses too', async () => {
      const s = scenario('generation-regress', undefined, GENERATION + 2);
      let child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.equal(await stop(child), 0);
      const hashBefore = fileHash(s.database);
      writeFileSync(s.configFile, JSON.stringify({ ...JSON.parse(readFileSync(s.configFile, 'utf8')), generation: GENERATION }));
      child = startLoop(s);
      assert.equal(await waitForExit(child), EXIT_JOURNAL_REFUSED, child.lines.join('|'));
      assert.deepEqual(child.lines, ['BROKER_FATAL=JOURNAL_GENERATION_REGRESSED', 'BROKER_STOPPED']);
      assert.equal(child.lines.includes('BROKER_READY'), false);
      assert.equal(fileHash(s.database), hashBefore, 'a refused start changes nothing: no epoch bump');
      const broker = track(startBroker(brokerExe, s.pipeName, s.database, authority.serveArgument, sid, GENERATION));
      assert.equal(await waitForExit(broker), EXIT_JOURNAL_REFUSED, broker.lines.join('|'));
      assert.deepEqual(broker.lines, ['BROKER_FATAL=JOURNAL_GENERATION_REGRESSED']);
      assert.equal(fileHash(s.database), hashBefore);
    });

    // [label, how to build the journal, reason word]. Each is refused before the pipe exists, with 76, and the file is not touched.
    const fenceSql = [
      'CREATE TABLE broker_state (id INTEGER PRIMARY KEY CHECK(id = 1), epoch INTEGER NOT NULL CHECK(epoch >= 0), lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1), clock_high_water INTEGER NOT NULL CHECK(clock_high_water >= 0));',
      "CREATE TABLE challenges (challenge TEXT PRIMARY KEY CHECK(length(challenge) = 22), epoch INTEGER NOT NULL, lease_generation INTEGER NOT NULL, computer_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('issued', 'consumed')));",
      'INSERT INTO broker_state VALUES (1, 0, 7, 0);',
    ];
    const refused = [
      ['a journal written by a newer Broker (version 4)', (db) => { makeJournal(db, LEGACY_SQL, 'PRAGMA user_version = 4;'); }, 'NEWER'],
      ['a far-future version', (db) => { makeJournal(db, LEGACY_SQL, 'PRAGMA user_version = 99;'); }, 'NEWER'],
      ['version 1, which no Broker ever wrote', (db) => { makeJournal(db, LEGACY_SQL, 'PRAGMA user_version = 1;'); }, 'UNSUPPORTED'],
      ['version 0 with a table that is not the legacy claims table', (db) => { makeJournal(db, 'CREATE TABLE something_else (x TEXT);'); }, 'UNSUPPORTED'],
      ['version 0 with the claims table plus another table', (db) => { makeJournal(db, LEGACY_SQL, 'CREATE TABLE extra (x TEXT);'); }, 'UNSUPPORTED'],
      ['version 0 with the claims table plus a table whose name only LOOKS like an internal one (sqliteXextra: "_" is a LIKE wildcard)', (db) => { makeJournal(db, LEGACY_SQL, 'CREATE TABLE sqliteXextra (x TEXT);'); }, 'UNSUPPORTED'],
      ['version 0 with the claims table plus an index', (db) => { makeJournal(db, LEGACY_SQL, 'CREATE INDEX claims_state ON claims(state);'); }, 'UNSUPPORTED'],
      ['version 0 with a claims table of other columns', (db) => { makeJournal(db, 'CREATE TABLE claims (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL);'); }, 'UNSUPPORTED'],
      ['version 0 with the legacy columns but another CREATE text (receipt_id is no longer UNIQUE)', (db) => { makeJournal(db, 'CREATE TABLE claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL);'); }, 'UNSUPPORTED'],
      ['version 2 whose claims table lost a column', (db) => { makeJournal(db, 'CREATE TABLE claims (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL);', 'PRAGMA user_version = 2;'); }, 'UNSUPPORTED'],
      ['version 2 with the right columns but a weakened CHECK (same names, other CREATE text)', (db) => { makeJournal(db, VERSION_2_SQL.replace(' CHECK(request_digest IS NULL OR length(request_digest) = 64)', ''), 'PRAGMA user_version = 2;'); }, 'UNSUPPORTED'],
      ['version 3 with only the legacy claims table', (db) => { makeJournal(db, LEGACY_SQL, 'PRAGMA user_version = 3;'); }, 'UNSUPPORTED'],
      ['version 3 whose broker_state lost its CHECK (same columns, other CREATE text)', (db) => { makeJournal(db, VERSION_2_SQL, fenceSql[0].replace(' CHECK(lease_generation >= 1)', ''), ...fenceSql.slice(1), 'PRAGMA user_version = 3;'); }, 'UNSUPPORTED'],
      ['version 3 with an extra trigger', (db) => { makeJournal(db, VERSION_2_SQL, ...fenceSql, 'CREATE TRIGGER t AFTER INSERT ON claims BEGIN SELECT 1; END;', 'PRAGMA user_version = 3;'); }, 'UNSUPPORTED'],
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

    it('accepts the current shape written with the exact CREATE statements (control for the refusals above)', async () => {
      const s = scenario('exact-v3', (db) => makeJournal(db, VERSION_2_SQL, ...fenceSql, 'PRAGMA user_version = 3;'));
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.equal(fenceRows(s.database).state.epoch, 1);
      assert.equal(await stop(child), 0);
    });

    it('the shipped one-shot `serve` refuses a newer journal with 76 before the pipe exists', async () => {
      const s = scenario('refused-serve', (db) => makeJournal(db, LEGACY_SQL, 'PRAGMA user_version = 4;'));
      const hashBefore = fileHash(s.database);
      const broker = track(startBroker(brokerExe, s.pipeName, s.database, authority.serveArgument, sid, GENERATION));
      assert.equal(await waitForExit(broker), EXIT_JOURNAL_REFUSED, broker.lines.join('|'));
      assert.deepEqual(broker.lines, ['BROKER_FATAL=JOURNAL_NEWER']);
      assert.equal(fileHash(s.database), hashBefore);
    });

    it('a journal that turns newer while the service runs is refused per request (claim, fence and inspect denied, nothing written) and works again once restored', async () => {
      const s = scenario('turns-newer');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const session = sessionOf(s, child);
      assert.deepEqual((await session.claim('before')).result, SUCCESS);
      const rows = snapshot(s.database).rows;
      setVersion(s.database, 4);
      assert.deepEqual(await session.fence(), DENIED);
      assert.deepEqual(await session.inspect('before-op'), DENIED);
      assert.equal(child.closeCode, undefined, 'still running');
      assert.equal(child.lines.filter((line) => line === 'REQUEST=DENIED').length, 2);
      setVersion(s.database, 3);
      assert.deepEqual(snapshot(s.database).rows, rows);
      assert.deepEqual((await session.claim('after')).result, SUCCESS);
      assert.equal(await stop(child), 0);
      assert.deepEqual(snapshot(s.database).rows.map((row) => row.operation_id), ['after-op', 'before-op']);
    });
  });

  describe('exact duplicate returns the recorded outcome', () => {
    it('the same receipt bytes and signature get the recorded outcome (replayed: true) and write nothing; every other collision stays denied', async () => {
      const s = scenario('duplicate');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const session = sessionOf(s, child);
      const { request: first, result } = await session.claim('dup');
      assert.deepEqual(result, SUCCESS, 'the first claim has no `replayed` key');
      const afterFirst = snapshot(s.database);
      const challengesAfterFirst = fenceRows(s.database).challenges;
      assert.equal(afterFirst.rows.length, 1);

      assert.deepEqual(await session.send(first), REPLAYED, 'exact duplicate');
      assert.deepEqual(await session.send({ ...first }), REPLAYED, 'and again');
      assert.equal(child.lines.filter((line) => line === 'REPLAY=RECORDED_OUTCOME').length, 2);
      assert.equal(child.lines.filter((line) => line === 'CLAIM=PERSISTED_UNKNOWN').length, 1, 'one claim only');
      assert.deepEqual(snapshot(s.database), afterFirst, 'a replay changes no row');
      assert.deepEqual(fenceRows(s.database).challenges, challengesAfterFirst, 'and no challenge');

      const resigned = { receipt: first.receipt, signature: authority.sign(Buffer.from(first.receipt, 'base64')) };
      assert.notEqual(resigned.signature, first.signature);
      assert.deepEqual(await session.send(resigned), DENIED, 'same receipt bytes, different signature: not an exact duplicate (and its challenge is spent)');
      assert.ok(child.lines.includes('DENY=challenge_consumed'));
      const different = await session.claim('dup', { idempotencyKey: 'another-key' });
      assert.deepEqual(different.result, DENIED, 'a different receipt for the same operationId');
      assert.deepEqual((await session.claim('dup-other', { receiptId: stableUuid('dup-receipt') })).result, DENIED, 'another operation reusing the receiptId');
      assert.deepEqual((await session.claim('dup-third', { approvalId: stableUuid('dup-approval') })).result, DENIED, 'another operation reusing the approvalId');
      assert.equal(child.lines.filter((line) => line === 'DENY=duplicate').length, 3);
      assert.equal(await stop(child), 0);
      assert.deepEqual(snapshot(s.database), afterFirst, 'no denied request left a row');
      // A collision rolls the whole claim back, so the challenge it would have spent is still unspent.
      assert.deepEqual(fenceRows(s.database).challenges.map((row) => row.state), ['consumed', 'issued', 'issued', 'issued'], 'only the first claim spent its challenge');
    });

    it('a replay never bypasses the receipt checks: an exact duplicate whose receipt has expired is denied', async () => {
      const s = scenario('duplicate-expiry');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const session = sessionOf(s, child);
      const { request: shortLived, result } = await session.claim('short', { ttlSeconds: 3 });
      assert.deepEqual(result, SUCCESS);
      assert.deepEqual(await session.send(shortLived), REPLAYED, 'still within the lifetime: the recorded outcome');
      await new Promise((resolve) => setTimeout(resolve, 3500));
      assert.deepEqual(await session.send(shortLived), DENIED, 'expired');
      assert.ok(child.lines.includes('DENY=expired'));
      assert.equal(await stop(child), 0);
      assert.equal(snapshot(s.database).rows.length, 1);
    });

    it('after a crash that lost the reply, the restarted Broker answers the exact duplicate from the journal and never claims twice (its challenge died with the old epoch)', async () => {
      const s = scenario('duplicate-crash');
      const held = startLoop(s, 60_000); // the claim is committed, then the answer is held back
      await waitForLine(held, 'BROKER_READY');
      const heldSession = sessionOf(s, held);
      const request = await heldSession.prepare('crash');
      const lost = heldSession.send(request).catch(() => undefined);
      await waitForLine(held, 'CLAIM=PERSISTED_UNKNOWN');
      held.kill();
      await waitForExit(held);
      await lost;
      const restarted = startLoop(s);
      await waitForLine(restarted, 'BROKER_READY');
      assert.deepEqual(fenceRows(s.database).challenges, [], 'a restart deletes every challenge');
      assert.deepEqual(await sessionOf(s, restarted).send(request), REPLAYED);
      assert.ok(restarted.lines.includes('REPLAY=RECORDED_OUTCOME') && !restarted.lines.includes('CLAIM=PERSISTED_UNKNOWN'), restarted.lines.join('|'));
      assert.equal(await stop(restarted), 0);
      assert.equal(snapshot(s.database).rows.length, 1);
    });
  });

  describe('read-only inspect request', () => {
    it('returns the recorded state of a claimed operation as synthetic.inspect, and changes nothing', async () => {
      const s = scenario('inspect');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const session = sessionOf(s, child);
      assert.deepEqual((await session.claim('target')).result, SUCCESS);
      const before = { claims: snapshot(s.database), fence: fenceRows(s.database) };
      assert.deepEqual(await session.inspect('target-op'), INSPECTED);
      assert.deepEqual(await session.inspect('target-op'), INSPECTED, 'it reads and consumes nothing, so it can be repeated');
      assert.equal(child.lines.filter((line) => line === 'INSPECT=RECORDED').length, 2);
      assert.equal(child.lines.filter((line) => line === 'CLAIM=PERSISTED_UNKNOWN').length, 1);
      assert.deepEqual({ claims: snapshot(s.database), fence: fenceRows(s.database) }, before, 'no row, no challenge, no version change');
      assert.equal(await stop(child), 0);
    });

    it('answers for an operation claimed before a crash whose reply was lost (the reconcile read), also after a restart', async () => {
      const s = scenario('inspect-crash');
      const held = startLoop(s, 60_000);
      await waitForLine(held, 'BROKER_READY');
      const heldSession = sessionOf(s, held);
      const request = await heldSession.prepare('lost');
      const lost = heldSession.send(request).catch(() => undefined);
      await waitForLine(held, 'CLAIM=PERSISTED_UNKNOWN');
      held.kill();
      await waitForExit(held);
      await lost;
      const restarted = startLoop(s);
      await waitForLine(restarted, 'BROKER_READY');
      const session = sessionOf(s, restarted);
      assert.deepEqual(await session.inspect('lost-op'), INSPECTED);
      assert.deepEqual(await session.inspect('never-claimed-op'), DENIED, 'no record: denied, nothing created');
      assert.equal(await stop(restarted), 0);
      assert.equal(snapshot(s.database).rows.length, 1);
    });

    it('an unknown operation is denied without a row', async () => {
      const s = scenario('inspect-none');
      const child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      const session = sessionOf(s, child);
      assert.deepEqual(await session.inspect('ghost-op'), DENIED);
      assert.deepEqual((await session.claim('real')).result, SUCCESS);
      assert.deepEqual(await session.inspect('ghost-op'), DENIED);
      assert.equal(child.lines.filter((line) => line === 'DENY=inspect-unknown').length, 2);
      assert.equal(await stop(child), 0);
      assert.deepEqual(snapshot(s.database).rows.map((row) => row.operation_id), ['real-op']);
    });
  });

  describe('restoring a backup of the journal (issue #84)', () => {
    // A backup is a file copy of a stopped Broker's journal; restoring it puts back an older epoch, older claims and challenges that were live when it was
    // taken. The fence is the start itself: every start adds one to the journal's epoch and deletes every challenge in the same transaction, so nothing
    // a receipt names can survive a restore, and the receipt TTL (300 s) bounds anything else. The cost, by design: claims made after the backup are gone.
    it('a receipt fenced before the backup and one claimed after it are both refused after the restore (challenge_unknown), nothing is written, and a fresh fence and claim still work', async () => {
      const s = scenario('restore');
      const backup = path.join(path.dirname(path.dirname(s.database)), 'backup.sqlite');

      let child = startLoop(s); // epoch 1: a receipt is fenced and signed but never sent, then the journal is backed up with its challenge still in it
      await waitForLine(child, 'BROKER_READY');
      const fencedBeforeBackup = await sessionOf(s, child).prepare('before-backup');
      assert.equal(await stop(child), 0);
      copyJournal(s.database, backup);
      assert.deepEqual(fenceRows(backup).challenges.map((row) => [row.epoch, row.state]), [[1, 'issued']], 'the backup holds a live challenge');

      child = startLoop(s); // epoch 2: the claim the backup does not know about
      await waitForLine(child, 'BROKER_READY');
      const session = sessionOf(s, child);
      const { request: claimedAfterBackup, result } = await session.claim('after-backup');
      assert.deepEqual(result, SUCCESS);
      assert.deepEqual(await session.send(claimedAfterBackup), REPLAYED, 'control: before the restore this exact duplicate is answered from the journal');
      assert.equal(await stop(child), 0);
      assert.deepEqual(snapshot(s.database).rows.map((row) => row.operation_id), ['after-backup-op']);

      restoreJournal(backup, s.database);
      assert.deepEqual([snapshot(s.database).rows.length, fenceRows(s.database).state.epoch], [0, 1], 'the restored file is the backup: epoch 1, no claim');

      child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(fenceView(s.database), { tables: CURRENT_TABLES, state: { epoch: 2, lease_generation: GENERATION }, challenges: [] }, 'the start made epoch 2 again (the backup\'s 1 plus 1) and deleted the challenge the backup held');
      const restored = sessionOf(s, child);
      assert.deepEqual(await restored.send(claimedAfterBackup), DENIED, 'same epoch number as before the restore, but its challenge is gone: not claimed again, not answered as a replay');
      assert.deepEqual(await restored.send(fencedBeforeBackup), DENIED, 'fenced before the backup, so its challenge was IN the restored file: the start deleted it');
      assert.equal(child.lines.filter((line) => line === 'DENY=challenge_unknown').length, 2, child.lines.join('|'));
      assert.equal(child.lines.includes('CLAIM=PERSISTED_UNKNOWN') || child.lines.includes('REPLAY=RECORDED_OUTCOME'), false);
      assert.equal(snapshot(s.database).rows.length, 0, 'the refusals wrote no claim');
      assert.deepEqual((await restored.claim('after-restore')).result, SUCCESS, 'a fresh fence and claim work on the restored journal');
      assert.equal(await stop(child), 0);
      assert.deepEqual(snapshot(s.database).rows.map((row) => row.operation_id), ['after-restore-op']);
    });

    it('a restored journal of a LOWER generation than the config is advanced to the config\'s (its old receipts are dead); one of a HIGHER generation refuses the start (76) and is left untouched', async () => {
      const s = scenario('restore-generation');
      const backupLow = path.join(path.dirname(path.dirname(s.database)), 'backup-low.sqlite');
      const backupHigh = path.join(path.dirname(path.dirname(s.database)), 'backup-high.sqlite');

      let child = startLoop(s); // generation 7, a receipt fenced and never sent
      await waitForLine(child, 'BROKER_READY');
      const oldReceipt = await sessionOf(s, child).prepare('gen-low');
      assert.equal(await stop(child), 0);
      copyJournal(s.database, backupLow);
      assert.equal(fenceRows(backupLow).state.lease_generation, GENERATION);

      writeConfig(s, { generation: GENERATION + 2 }); // the operator raised the generation twice since: 9
      child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.equal(await stop(child), 0);
      copyJournal(s.database, backupHigh);
      assert.equal(fenceRows(backupHigh).state.lease_generation, GENERATION + 2);

      writeConfig(s, { generation: GENERATION + 1 }); // the config now says 8: the backup of 7 is below it
      restoreJournal(backupLow, s.database);
      child = startLoop(s);
      await waitForLine(child, 'BROKER_READY');
      assert.deepEqual(fenceView(s.database).state, { epoch: 2, lease_generation: GENERATION + 1 }, 'advanced to the config floor, epoch = the backup\'s 1 plus 1');
      const session = sessionOf(s, child);
      assert.deepEqual(await session.send(oldReceipt), DENIED, 'a receipt for generation 7 is dead');
      assert.equal((await session.fence()).leaseGeneration, GENERATION + 1);
      assert.deepEqual((await session.claim('gen-advanced')).result, SUCCESS);
      assert.equal(await stop(child), 0);

      restoreJournal(backupHigh, s.database); // a backup of generation 9 under a config of 8 would un-revoke generations 8 and 9
      const hashBefore = fileHash(s.database);
      child = startLoop(s);
      assert.equal(await waitForExit(child), EXIT_JOURNAL_REFUSED, child.lines.join('|'));
      assert.deepEqual(child.lines, ['BROKER_FATAL=JOURNAL_GENERATION_REGRESSED', 'BROKER_STOPPED']);
      assert.equal(fileHash(s.database), hashBefore, 'a refused start changes nothing: no epoch bump');
      assert.equal(existsSync(`${s.database}-wal`), false);
    });
  });
});
