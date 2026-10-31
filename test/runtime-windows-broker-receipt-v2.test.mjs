import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  brokerSession, buildBroker, buildBrokerWithTestSeams, buildPipeClient, buildReceiptFields, createTestAuthority, currentUserSid, getUnavailableReason, makeTrustedTempDirectory,
  rawFencedClaim, rawRequest, signedReceipt, standInService, startBroker, startProcess, stableUuid, waitForExit, waitForLine, COMPUTER_ID, GENERATION, LEASE_CONFIG, LEASE_ID, POLICY_VERSION, PRODUCTION_ISSUER, TEST_ISSUER,
} from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged (decision-log row 2026-10-30+broker-receipt-v2). The .NET Broker enforces receipt v2 (src/runtime/broker-contract):
// the Broker issues the challenge (`fence`), the test authority signs a receipt that names it, the Broker validates with the shared contract and records
// the claim. Every refusal is the one fixed `denied` reply; the reason is a fixed word on the Broker's stdout (DENY=<reason>), which is what these tests read.
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const DENIED = { ok: false, code: 'denied' };
const CHALLENGE = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('Broker receipt v2 and the fence request', { skip: getUnavailableReason() }, () => {
  let root, brokerExe, loopExe, helper, sid, authority;
  const running = new Set();
  before(async () => {
    root = makeTrustedTempDirectory('albera-receipt-v2-');
    brokerExe = buildBroker(path.join(root, 'broker')); // the shipped build: production issuer rule
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams')); // + `serve-loop`, and `albera-test-*` issuers are accepted
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
    authority = createTestAuthority();
  });
  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const track = (child) => { running.add(child); child.once('close', () => running.delete(child)); return child; };
  let scenarios = 0;
  /** A running seam-build Broker on a fresh trusted folder. `keys` are the pinned authorities (default: the one test authority). */
  async function start({ keys = [authority], generation = GENERATION, folder, clockOffset, lease = LEASE_CONFIG } = {}) {
    const dir = folder ?? path.join(root, `s${(scenarios += 1)}`);
    if (!folder) { mkdirSync(dir); mkdirSync(path.join(dir, 'db')); }
    const database = path.join(dir, 'db', 'journal.sqlite');
    const configFile = path.join(dir, 'config.json');
    const config = { pipeName: `ALBERA_Receipt_${randomBytes(6).toString('hex')}`, database, authorityKeys: keys.map((key) => key.keyEntry), controlPlaneSid: sid, generation, ...lease };
    writeFileSync(configFile, JSON.stringify(config));
    const s = { ...config, dir, configFile };
    // ALBERA_BROKER_TEST_CLOCK_OFFSET exists only in the seam build: it moves this process's clock so a rollback between two runs can be rehearsed.
    s.child = track(startProcess(loopExe, standInService('serve-loop', configFile), { stdin: true, ...(clockOffset ? { env: { ALBERA_BROKER_TEST_CLOCK_OFFSET: String(clockOffset) } } : {}) }));
    await waitForLine(s.child, 'BROKER_READY');
    s.session = brokerSession({ helper, sid, pipeName: config.pipeName, pid: s.child.pid, authority });
    s.stop = async () => { s.child.stdin.end(); return waitForExit(s.child); };
    s.restart = async () => {
      assert.equal(await s.stop(), 0);
      return start({ keys, generation, folder: dir, lease });
    };
    return s;
  }
  const withJournal = (s, fn) => { const db = new DatabaseSync(s.database); try { return fn(db); } finally { db.close(); } };
  const claimsOf = (s) => withJournal(s, (db) => db.prepare('SELECT operation_id FROM claims ORDER BY operation_id').all().map((row) => row.operation_id));
  const challengesOf = (s) => withJournal(s, (db) => db.prepare('SELECT challenge, epoch, lease_generation, computer_id, state FROM challenges ORDER BY rowid').all().map((row) => ({ ...row })));
  const lastReason = (s) => s.child.lines.filter((line) => line.startsWith('DENY=')).at(-1);

  describe('fence', () => {
    it('answers { ok, brokerEpoch, leaseGeneration, brokerChallenge } and stores a single-use 128-bit challenge for the computer in the journal', async () => {
      const s = await start();
      const first = await s.session.fence();
      // The pipe client helper does not relay `leaseId` yet (the raw reply is checked in the next test), so it is left out of this comparison.
      assert.deepEqual(Object.keys(first).filter((key) => key !== 'leaseId').sort(), ['brokerChallenge', 'brokerEpoch', 'leaseGeneration', 'ok']);
      assert.deepEqual([first.ok, first.brokerEpoch, first.leaseGeneration], [true, 1, GENERATION]);
      assert.match(first.brokerChallenge, CHALLENGE);
      assert.equal(Buffer.from(first.brokerChallenge, 'base64url').length, 16, '128 bits');
      const second = await s.session.fence('computer-2');
      assert.notEqual(second.brokerChallenge, first.brokerChallenge, 'every fence is a new challenge');
      assert.deepEqual(challengesOf(s), [
        { challenge: first.brokerChallenge, epoch: 1, lease_generation: GENERATION, computer_id: COMPUTER_ID, state: 'issued' },
        { challenge: second.brokerChallenge, epoch: 1, lease_generation: GENERATION, computer_id: 'computer-2', state: 'issued' },
      ]);
      assert.equal(s.child.lines.filter((line) => line === 'FENCE=ISSUED').length, 2);
      assert.equal(await s.stop(), 0);
    });

    it('names the lease the Broker is configured for (raw reply: exactly five keys), and a receipt must name that lease and policy, not a placeholder', async () => {
      const lease = { leaseId: 'lease-configured-a', policyVersion: 'policy-configured-a' };
      const s = await start({ lease });
      const fence = await rawRequest(s.pipeName, { fence: { computerId: COMPUTER_ID } });
      assert.deepEqual(Object.keys(fence), ['ok', 'brokerEpoch', 'leaseGeneration', 'leaseId', 'brokerChallenge']);
      assert.equal(fence.leaseId, lease.leaseId);
      // The receipt takes leaseId from the fence reply, as the Control Plane does; the policy is the one the Authority would sign (the same config value).
      const accepted = await rawFencedClaim(s.pipeName, authority, 'configured', { policyVersion: lease.policyVersion });
      assert.deepEqual(accepted.reply, SUCCESS);
      assert.equal(accepted.fence.leaseId, lease.leaseId);
      const placeholders = [
        ['the former placeholder lease', { leaseId: LEASE_ID, policyVersion: lease.policyVersion }],
        ['the former placeholder policy', { policyVersion: POLICY_VERSION }],
        ['another policy version', { policyVersion: 'policy-configured-b' }],
      ];
      for (const [index, [label, overrides]] of placeholders.entries()) {
        const { reply } = await rawFencedClaim(s.pipeName, authority, `configured-refused-${index}`, overrides);
        assert.deepEqual(reply, DENIED, label);
        assert.equal(lastReason(s), 'DENY=binding', label);
      }
      assert.deepEqual(claimsOf(s), ['configured-op']);
      assert.equal(await s.stop(), 0);
    });

    it('a Broker restarted with another leaseId serves the new one: a receipt for the old lease is refused, and so is a replay of a claim made under it', async () => {
      const old = { leaseId: 'lease-old', policyVersion: POLICY_VERSION };
      const first = await start({ lease: old });
      const { fence, request, reply } = await rawFencedClaim(first.pipeName, authority, 'lease-change');
      assert.deepEqual(reply, SUCCESS);
      assert.equal(fence.leaseId, 'lease-old');
      assert.equal(await first.stop(), 0);
      const second = await start({ lease: { ...old, leaseId: 'lease-new' }, folder: first.dir });
      assert.equal((await rawRequest(second.pipeName, { fence: { computerId: COMPUTER_ID } })).leaseId, 'lease-new');
      assert.deepEqual(await rawRequest(second.pipeName, request), DENIED, 'the exact duplicate names a lease this Broker no longer serves');
      assert.equal(lastReason(second), 'DENY=binding');
      assert.equal(await second.stop(), 0);
    });

    it('is a request of its own: nothing but { fence: { computerId } } with a contract id is a fence, and every other shape is denied', async () => {
      const s = await start();
      const marker = 'SYNTHETIC_SECRET_MARKER';
      const bad = [
        {}, { fence: {} }, { fence: { computerId: '' } }, { fence: { computerId: 'has space' } }, { fence: { computerId: 'x'.repeat(65) } }, { fence: { computerId: 5 } },
        { fence: { computerId: COMPUTER_ID, extra: 1 } }, { fence: COMPUTER_ID }, { fence: [COMPUTER_ID] }, { fence: null },
        { fence: { computerId: COMPUTER_ID }, other: 1 }, { inspect: { operationId: 'a b' } }, { inspect: {} }, { inspect: { operationId: 'a', extra: 1 } },
        { receipt: 'AAAA', signature: 'AAAA', fence: { computerId: COMPUTER_ID } }, { receipt: 'AAAA' }, { signature: 'AAAA' }, { [marker]: marker },
      ];
      for (const body of bad) assert.deepEqual(await rawRequest(s.pipeName, body), DENIED, JSON.stringify(body));
      assert.equal(s.child.lines.some((line) => line.includes(marker)), false, 'no request text reaches the log');
      assert.deepEqual(challengesOf(s), [], 'nothing was issued');
      assert.equal(await s.stop(), 0);
    });

    it('keeps at most 64 challenges: the oldest is dropped, which can only make it unknown (denied), never usable twice', async () => {
      const s = await start();
      const replies = [];
      for (let index = 0; index < 66; index += 1) replies.push(await rawRequest(s.pipeName, { fence: { computerId: COMPUTER_ID } }));
      assert.equal(challengesOf(s).length, 64);
      const oldest = replies[0];
      assert.deepEqual(await rawRequest(s.pipeName, signed(authority, oldest, 'evicted')), DENIED);
      assert.equal(lastReason(s), 'DENY=challenge_unknown');
      const newest = replies.at(-1);
      assert.deepEqual(await rawRequest(s.pipeName, signed(authority, newest, 'kept')), SUCCESS);
      assert.equal(await s.stop(), 0);
    });

    it('a Broker restart starts a new epoch and deletes every challenge; a generation that advances makes older challenges stale', async () => {
      let s = await start();
      const old = await s.session.fence();
      assert.equal(old.brokerEpoch, 1);
      s = await s.restart();
      assert.deepEqual(challengesOf(s), [], 'the new epoch starts without challenges');
      const stale = signed(authority, old, 'old-challenge');
      assert.deepEqual(await s.session.send(stale), DENIED);
      assert.equal(lastReason(s), 'DENY=challenge_unknown', 'the challenge of the previous process is unknown');
      const fresh = await s.session.fence();
      assert.equal(fresh.brokerEpoch, 2);

      withJournal(s, (db) => db.exec('UPDATE broker_state SET lease_generation = 8'));
      assert.deepEqual(await s.session.send(signed(authority, fresh, 'before-advance')), DENIED);
      assert.equal(lastReason(s), 'DENY=generation_stale', 'a challenge from generation 7 cannot be used once the lease is at 8 (its receipt says 7 too)');
      const next = await s.session.fence();
      assert.equal(next.leaseGeneration, 8, 'the generation is the journal\'s, not the config\'s');
      assert.deepEqual(await s.session.send(signed(authority, next, 'after-advance')), SUCCESS);
      assert.equal(await s.stop(), 0);
    });

    it('stops answering when the journal\'s epoch is not the one this process started (another writer, or the file was replaced): fence and claim are denied', async () => {
      const s = await start();
      const fence = await s.session.fence();
      withJournal(s, (db) => db.exec('UPDATE broker_state SET epoch = epoch + 1'));
      assert.deepEqual(await s.session.fence(), DENIED);
      assert.equal(lastReason(s), 'DENY=epoch_mismatch');
      assert.deepEqual(await s.session.send(signed(authority, fence, 'foreign-epoch')), DENIED);
      assert.equal(lastReason(s), 'DENY=epoch_mismatch');
      assert.deepEqual(claimsOf(s), []);
      assert.equal(await s.stop(), 0);
    });
  });

  describe('claim', () => {
    it('accepts a receipt that names a fresh challenge, records it as UNKNOWN, consumes the challenge, and raises the clock high-water mark to its iat', async () => {
      const s = await start();
      const { request, result } = await s.session.claim('good');
      assert.deepEqual(result, SUCCESS);
      assert.deepEqual(claimsOf(s), ['good-op']);
      assert.deepEqual(challengesOf(s).map((row) => row.state), ['consumed']);
      const iat = JSON.parse(Buffer.from(request.receipt, 'base64')).iat;
      assert.equal(withJournal(s, (db) => db.prepare('SELECT clock_high_water AS hw FROM broker_state').get().hw), iat);
      assert.equal(await s.stop(), 0);
    });

    it('a challenge is single use: a second, different receipt that names a spent challenge is denied', async () => {
      const s = await start();
      const { request } = await s.session.claim('first');
      assert.deepEqual(await s.session.send(signed(authority, request.fence, 'second')), DENIED);
      assert.equal(lastReason(s), 'DENY=challenge_consumed');
      assert.deepEqual(claimsOf(s), ['first-op']);
      assert.equal(await s.stop(), 0);
    });

    // [label, overrides (object or function of the fence reply), fenced computer, the reason word]. Each is denied, leaves no claim, and leaves its challenge unspent.
    const unspent = [
      ['a kid that is not pinned', { kid: 'unpinned-key' }, undefined, 'kid_unknown'],
      ['a TTL of 301 seconds', { ttlSeconds: 301 }, undefined, 'ttl_exceeded'],
      ['an iat more than 30 seconds ahead', () => ({ now: nowSeconds() + 60 }), undefined, 'not_yet_valid'],
      ['an expiry that has passed', () => ({ now: nowSeconds() - 200, ttlSeconds: 100 }), undefined, 'expired'],
      ['a broker epoch the challenge was not issued for', (fence) => ({ brokerEpoch: fence.brokerEpoch + 1 }), undefined, 'epoch_mismatch'],
      ['a stale lease generation', (fence) => ({ leaseGeneration: fence.leaseGeneration - 1 }), undefined, 'generation_stale'],
      ['a challenge that was never issued', { brokerChallenge: 'AAAAAAAAAAAAAAAAAAAAAA' }, undefined, 'challenge_unknown'],
      ['a computer other than the one the challenge was issued for', { computerId: 'computer-2' }, COMPUTER_ID, 'computer_mismatch'],
      ['another audience', { audience: 'albera-other-service' }, undefined, 'binding'],
      ['another lease id', { leaseId: 'other-lease' }, undefined, 'binding'],
      ['another policy version', { policyVersion: 'other-policy' }, undefined, 'binding'],
      ['purpose guest.command', { purpose: 'guest.command' }, undefined, 'binding'],
      ['an action other than the fixed synthetic one', { action: 'environment.create' }, undefined, 'binding'],
      ['an action digest the Broker does not compute from the trusted DTO', { actionDigest: `sha256:${'0'.repeat(64)}` }, undefined, 'action_digest'],
      ['an action that does not belong to the purpose', { action: 'task.start', actionDigest: `sha256:${'1'.repeat(64)}` }, undefined, 'action_pair'],
      ['the former read-only action as a receipt action (the contract does not know it)', { action: 'synthetic.inspect', actionDigest: `sha256:${'2'.repeat(64)}` }, undefined, 'schema'],
      ['a version other than 2', { v: 4 }, undefined, 'version'],
      ['a v2 body that claims version 3 (it has no basis and a label as policyVersion)', { v: 3 }, undefined, 'schema'],
      ['an unknown extra key', { extraKey: 'x' }, undefined, 'schema'],
    ];
    for (const [label, overrides, fenced, reason] of unspent) {
      it(`denies ${label} (DENY=${reason}) without claiming and without spending the challenge`, async () => {
        const s = await start();
        const { result } = await s.session.claim('refused', overrides, fenced);
        assert.deepEqual(result, DENIED);
        assert.equal(lastReason(s), `DENY=${reason}`, s.child.lines.join('|'));
        assert.deepEqual(claimsOf(s), []);
        assert.deepEqual(challengesOf(s).map((row) => row.state), ['issued']);
        assert.equal(await s.stop(), 0);
      });
    }

    it('denies a bad signature, bytes edited after signing, and unparseable receipt bytes, each with its own reason', async () => {
      const s = await start();
      const good = await s.session.prepare('edited');
      const other = createTestAuthority({ kid: authority.kid });
      assert.deepEqual(await s.session.send({ receipt: good.receipt, signature: other.sign(Buffer.from(good.receipt, 'base64')) }), DENIED, 'right kid, signed by another key');
      assert.equal(lastReason(s), 'DENY=signature');
      const edited = Buffer.from(Buffer.from(good.receipt, 'base64').toString('utf8').replace('edited-op', 'edited-ox')).toString('base64');
      assert.deepEqual(await s.session.send({ receipt: edited, signature: good.signature }), DENIED, 'one byte changed after signing');
      assert.equal(lastReason(s), 'DENY=signature');
      for (const [label, signature] of [['empty', ''], ['3 bytes', 'AAAA'], ['65 bytes', Buffer.alloc(65, 1).toString('base64')], ['64 zero bytes', Buffer.alloc(64).toString('base64')]]) {
        assert.deepEqual(await rawRequest(s.pipeName, { receipt: good.receipt, signature }), DENIED, `${label} signature`);
        assert.equal(lastReason(s), 'DENY=signature', `${label} signature`);
      }
      assert.equal(s.child.closeCode, undefined, 'the service survived every malformed signature');
      for (const [text, reason] of [['{"v":2,', 'malformed'], ['[]', 'malformed'], [`{"v":2,"v":2}`, 'malformed'], ['{}', 'schema']]) {
        const bytes = Buffer.from(text);
        assert.deepEqual(await s.session.send({ receipt: bytes.toString('base64'), signature: authority.sign(bytes) }), DENIED, text);
        assert.equal(lastReason(s), `DENY=${reason}`, text);
      }
      assert.deepEqual(claimsOf(s), []);
      assert.deepEqual(challengesOf(s).map((row) => row.state), ['issued']);
      assert.equal(await s.stop(), 0);
    });

    it('two pinned authority keys (rotation overlap): a receipt signed with either key is accepted by its kid, a third key never is', async () => {
      const second = createTestAuthority({ kid: 'test-authority-2' });
      const third = createTestAuthority({ kid: 'test-authority-3' });
      const s = await start({ keys: [authority, second] });
      const withKey = async (key, name) => {
        const fence = await s.session.fence();
        return s.session.send(signed(key, fence, name));
      };
      assert.deepEqual(await withKey(authority, 'first-key'), SUCCESS);
      assert.deepEqual(await withKey(second, 'second-key'), SUCCESS);
      assert.deepEqual(await withKey(third, 'third-key'), DENIED);
      assert.equal(lastReason(s), 'DENY=kid_unknown');
      const crossed = createTestAuthority({ kid: 'test-authority-2' }); // the pinned kid, but not the pinned key
      assert.deepEqual(await withKey(crossed, 'crossed-key'), DENIED);
      assert.equal(lastReason(s), 'DENY=signature');
      assert.deepEqual(claimsOf(s), ['first-key-op', 'second-key-op']);
      assert.equal(await s.stop(), 0);
    });

    it('the digest is recomputed from the trusted DTO (projectId and computerId from the receipt): changing either after the digest was computed is refused', async () => {
      const s = await start();
      const { request: base } = await s.session.claim('digest-base');
      const fields = JSON.parse(Buffer.from(base.receipt, 'base64'));
      const fence = await s.session.fence();
      const otherProject = buildReceiptFields({ authority, fence, name: 'digest-project', projectId: 'project-2', actionDigest: fields.actionDigest });
      const bytes = Buffer.from(JSON.stringify(otherProject));
      assert.deepEqual(await s.session.send({ receipt: bytes.toString('base64'), signature: authority.sign(bytes) }), DENIED);
      assert.equal(lastReason(s), 'DENY=action_digest');
      assert.equal(await s.stop(), 0);
    });

    it('a receipt of the maximum grammar size (64-character ids everywhere) still fits the 2 KiB frame', async () => {
      const s = await start();
      const id = (letter) => letter.repeat(64);
      const { request, result } = await s.session.claim('long', { operationId: id('o'), idempotencyKey: id('i'), projectId: id('p'), computerId: id('c'), leaseId: 'test-lease' });
      assert.deepEqual(result, SUCCESS);
      assert.ok(Buffer.from(request.receipt, 'base64').length <= 1280);
      assert.equal(await s.stop(), 0);
    });
  });

  describe('clock fence', () => {
    it('refuses every claim while now is more than 30 seconds behind the largest iat ever accepted (clock_rollback), claims and replays alike; fence and inspect still work', async () => {
      const s = await start();
      const { request } = await s.session.claim('before-rollback');
      const ahead = nowSeconds() + 3600;
      withJournal(s, (db) => db.exec(`UPDATE broker_state SET clock_high_water = ${ahead}`));
      assert.deepEqual(await s.session.claim('during-rollback').then((x) => x.result), DENIED);
      assert.equal(lastReason(s), 'DENY=clock_rollback');
      assert.deepEqual(await s.session.send(request), DENIED, 'an exact duplicate is not exempt');
      assert.equal(lastReason(s), 'DENY=clock_rollback');
      assert.equal((await s.session.fence()).ok, true);
      assert.equal((await s.session.inspect('before-rollback-op')).ok, true);
      assert.deepEqual(claimsOf(s), ['before-rollback-op']);
      withJournal(s, (db) => db.exec(`UPDATE broker_state SET clock_high_water = ${nowSeconds() + 25}`)); // within the 30 s allowance
      assert.deepEqual(await s.session.claim('inside-allowance').then((x) => x.result), SUCCESS);
      assert.equal(await s.stop(), 0);
    });

    it('the mark also follows the Broker\'s own clock: a fence raises it, so a clock that goes back more than 30 seconds after fences (no claim ever accepted) is detected', async () => {
      let s = await start();
      await s.session.fence();
      assert.ok(Math.abs(withJournal(s, (db) => db.prepare('SELECT clock_high_water AS hw FROM broker_state').get().hw) - nowSeconds()) <= 5);
      assert.equal(await s.stop(), 0);
      s = await start({ folder: s.dir, clockOffset: -120 }); // the restarted process believes it is two minutes earlier
      assert.deepEqual(await s.session.claim('after-rollback').then((x) => x.result), DENIED);
      assert.equal(lastReason(s), 'DENY=clock_rollback', s.child.lines.join('|'));
      assert.deepEqual(claimsOf(s), []);
      assert.equal(await s.stop(), 0);
      s = await start({ folder: s.dir }); // the real clock again: accepted
      assert.deepEqual(await s.session.claim('clock-back-to-normal').then((x) => x.result), SUCCESS);
      assert.equal(await s.stop(), 0);
    });

    it('a start raises the mark too: a Broker that only started once and is restarted with a clock 2 minutes behind refuses claims', async () => {
      let s = await start();
      assert.equal(await s.stop(), 0);
      s = await start({ folder: s.dir, clockOffset: -120 });
      assert.deepEqual(await s.session.claim('after-rollback-2').then((x) => x.result), DENIED);
      assert.equal(lastReason(s), 'DENY=clock_rollback');
      assert.equal(await s.stop(), 0);
    });

    it('a rollback of 20 seconds is inside the 30-second allowance and is not refused', async () => {
      let s = await start();
      await s.session.fence();
      assert.equal(await s.stop(), 0);
      s = await start({ folder: s.dir, clockOffset: -20 });
      assert.deepEqual(await s.session.claim('small-rollback').then((x) => x.result), SUCCESS);
      assert.equal(await s.stop(), 0);
    });

    it('a receipt issued up to 30 seconds ahead is accepted and moves the high-water mark; one issued at the real time is accepted right after', async () => {
      const s = await start();
      const ahead = nowSeconds() + 25;
      assert.deepEqual(await s.session.claim('ahead', { now: ahead }).then((x) => x.result), SUCCESS);
      assert.equal(withJournal(s, (db) => db.prepare('SELECT clock_high_water AS hw FROM broker_state').get().hw), ahead);
      assert.deepEqual(await s.session.claim('real-time').then((x) => x.result), SUCCESS);
      assert.equal(withJournal(s, (db) => db.prepare('SELECT clock_high_water AS hw FROM broker_state').get().hw), ahead, 'the mark only goes up');
      assert.equal(await s.stop(), 0);
    });
  });

  describe('issuer: production and test', () => {
    it('the test-faults build accepts an `albera-test-*` issuer, the shipped one-shot `serve` refuses it (issuer_test) and accepts the production issuer', async () => {
      const s = await start();
      assert.deepEqual(await s.session.claim('test-issuer', { issuer: TEST_ISSUER }).then((x) => x.result), SUCCESS);
      assert.equal(await s.stop(), 0);

      const dir = path.join(root, `shipped-${(scenarios += 1)}`);
      mkdirSync(dir);
      const pipeName = `ALBERA_Shipped_${randomBytes(6).toString('hex')}`;
      const refused = track(startBroker(brokerExe, pipeName, path.join(dir, 'a.sqlite'), authority.serveArgument, sid, GENERATION));
      await waitForLine(refused, 'BROKER_READY');
      const refusedSession = brokerSession({ helper, sid, pipeName, pid: refused.pid, authority });
      assert.deepEqual((await refusedSession.claim('shipped-test', { issuer: TEST_ISSUER })).result, DENIED);
      assert.equal(await waitForExit(refused), 0);
      assert.ok(refused.lines.includes('DENY=issuer_test'), refused.lines.join('|'));
      assert.equal(refused.lines.includes('CLAIM=PERSISTED_UNKNOWN'), false);

      const accepted = track(startBroker(brokerExe, pipeName, path.join(dir, 'b.sqlite'), authority.serveArgument, sid, GENERATION));
      await waitForLine(accepted, 'BROKER_READY');
      const acceptedSession = brokerSession({ helper, sid, pipeName, pid: accepted.pid, authority });
      assert.deepEqual((await acceptedSession.claim('shipped-production', { issuer: PRODUCTION_ISSUER })).result, SUCCESS);
      assert.equal(await waitForExit(accepted), 0);
    });
  });

  // Receipt v3 (issue #115 step 3): v2 + `basis`, with the policy hash as `policyVersion`. The Broker claims only the fixed synthetic.noop action today, so a v3 receipt can
  // only be claimed for that action: basis `policy` is capped to the actions a policy may skip (none of which is synthetic.noop), hence refused here with basis_action.
  describe('receipt v3: basis', () => {
    const POLICY_HASH = `sha256:${'ab'.repeat(32)}`;
    const v3 = (basis, extra = {}) => ({ v: 3, basis, policyVersion: POLICY_HASH, ...extra });

    it('accepts a v2 receipt and a v3 receipt with basis presence in the same Broker; v3 policyVersion is a hash the Broker does not compare with its own label', async () => {
      const s = await start();
      assert.deepEqual(await s.session.claim('v2-control').then((x) => x.result), SUCCESS);
      assert.deepEqual(await s.session.claim('v3-presence', v3('presence')).then((x) => x.result), SUCCESS);
      assert.deepEqual(claimsOf(s), ['v2-control-op', 'v3-presence-op']);
      assert.equal(s.child.lines.filter((line) => line === 'CLAIM=PERSISTED_UNKNOWN').length, 2);
      assert.equal(await s.stop(), 0);
    });

    it('an exact duplicate of a v3 receipt returns the recorded outcome and writes no second row', async () => {
      const s = await start();
      const first = await s.session.claim('v3-dup', v3('presence'));
      assert.deepEqual(first.result, SUCCESS);
      assert.deepEqual(await s.session.send(first.request).then((r) => ({ ok: r.ok, state: r.state })), { ok: true, state: 'UNKNOWN' });
      assert.deepEqual(claimsOf(s), ['v3-dup-op']);
      assert.equal(s.child.lines.includes('REPLAY=RECORDED_OUTCOME'), true);
      assert.equal(await s.stop(), 0);
    });

    it('refuses a v3 receipt whose basis is not presence or policy: an unknown word, a grant (reserved), a case variant, an empty string and a missing basis (schema)', async () => {
      const s = await start();
      const cases = [['unknown word', v3('approved')], ['grant', v3('grant:g-0001')], ['case variant', v3('Policy')], ['empty', v3('')], ['missing', { v: 3, policyVersion: POLICY_HASH }]];
      for (const [index, [label, overrides]] of cases.entries()) {
        const { reply } = await rawFencedClaim(s.pipeName, authority, `v3-bad-basis-${index}`, overrides);
        assert.deepEqual(reply, DENIED, label);
        assert.equal(lastReason(s), 'DENY=schema', label);
      }
      assert.deepEqual(claimsOf(s), []);
      assert.equal(await s.stop(), 0);
    });

    it('refuses basis policy for any action outside the policy-skippable set (basis_action), and a v3 receipt that still carries a v2 policy label (schema)', async () => {
      const s = await start();
      assert.deepEqual((await rawFencedClaim(s.pipeName, authority, 'v3-policy-noop', v3('policy'))).reply, DENIED);
      assert.equal(lastReason(s), 'DENY=basis_action', 'synthetic.noop is not something a policy may skip');
      assert.deepEqual((await rawFencedClaim(s.pipeName, authority, 'v3-label', v3('presence', { policyVersion: POLICY_VERSION }))).reply, DENIED);
      assert.equal(lastReason(s), 'DENY=schema');
      assert.deepEqual(claimsOf(s), []);
      assert.equal(await s.stop(), 0);
    });

    it('a policy receipt for a skippable action is not claimable here: this Broker binds the fixed synthetic.noop action (binding)', async () => {
      const s = await start();
      const { reply } = await rawFencedClaim(s.pipeName, authority, 'v3-policy-stop', v3('policy', { action: 'environment.stop' }));
      assert.deepEqual(reply, DENIED);
      assert.equal(lastReason(s), 'DENY=binding');
      assert.deepEqual(claimsOf(s), []);
      assert.equal(await s.stop(), 0);
    });

    it('basis is covered by the signature: changing presence to policy after signing is refused (signature), and so is a v3 body signed by an unpinned key', async () => {
      const s = await start();
      const flipped = await rawFencedClaim(s.pipeName, authority, 'v3-flip', v3('presence'), (request) => {
        const body = JSON.parse(Buffer.from(request.receipt, 'base64').toString('utf8'));
        return { ...request, receipt: Buffer.from(JSON.stringify({ ...body, basis: 'policy' }), 'utf8').toString('base64') };
      });
      assert.deepEqual(flipped.reply, DENIED);
      assert.equal(lastReason(s), 'DENY=signature');
      const stranger = createTestAuthority({ kid: authority.kid });
      assert.deepEqual((await rawFencedClaim(s.pipeName, stranger, 'v3-stranger', v3('presence'))).reply, DENIED);
      assert.equal(lastReason(s), 'DENY=signature');
      assert.deepEqual(claimsOf(s), []);
      assert.equal(await s.stop(), 0);
    });
  });

  describe('forms of the stable ids', () => {
    it('stableUuid is deterministic and grammar-valid', () => {
      assert.equal(stableUuid('a'), stableUuid('a'));
      assert.notEqual(stableUuid('a'), stableUuid('b'));
      assert.match(stableUuid('a'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    });
  });
});

/** A receipt for an existing fence reply, signed by `key`. */
function signed(key, fence, name) { return signedReceipt({ authority: key, fence, name }); }
