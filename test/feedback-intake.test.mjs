// The intake Worker (services/feedback-intake) on Node with fakes: the SQL port is node:sqlite in memory, GitHub is a recorded fake fetch, keys are made here.
// This proves the decisions and the request shapes, not Cloudflare's runtime (Durable Object, rate limit binding) or GitHub itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { handleFeedback, ipBucket, isLoopbackOrigin } from '../services/feedback-intake/src/intake.mjs';
import { LimitsBook, IntakeLimits, DAILY_LIMITS } from '../services/feedback-intake/src/limits.mjs';
import { createGitHubIssues, pkcs8Der } from '../services/feedback-intake/src/github-app.mjs';
import { issueOf } from '../services/feedback-intake/src/issue-format.mjs';
import worker from '../services/feedback-intake/src/index.mjs';
import { FAKE_SECRETS } from './helpers/fake-secrets.mjs';

/** Durable Objects' sql port on node:sqlite: exec(query, ...bindings) -> { toArray() }. */
function sqlPort() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      if (bindings.length === 0 && query.trim().split(';').filter((part) => part.trim()).length > 1) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = statement.all(...bindings);
        return { toArray: () => rows };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

const ORIGIN = 'http://127.0.0.1:51234';
const NOW = Date.parse('2026-11-04T05:00:00Z');
const payload = (extra = {}) => ({ v: 1, text: 'The camera froze after approval.', draftId: 'draft0000000000001', installDay: 'install00000000000001', version: '0.2.0 (7403ef2)', ...extra });
const encode = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

function harness({ github, burstOk = true, now = NOW } = {}) {
  const issues = [];
  let counter = 0;
  const ports = {
    open: true,
    book: new LimitsBook(sqlPort()),
    burst: { limit: async () => ({ success: burstOk }) },
    github: github ?? { createIssue: async (issue) => { issues.push(issue); return { number: issues.length }; } },
    hmac: async (text) => `h_${text.replace(/[^A-Za-z0-9]/g, '_')}`,
    sha256: async (text) => `s_${text}`,
    randomBytes: () => { counter += 1; return new Uint8Array([0, 0, counter >> 6, (counter & 63) << 2]); },
    now: () => now,
  };
  const send = (body, extra = {}) => handleFeedback({
    origin: ORIGIN, contentType: 'application/json', contentLength: null, ip: '203.0.113.7',
    readBody: async (max) => { const bytes = encode(body); return bytes.length > max ? null : bytes; },
    ...extra,
  }, ports);
  return { ports, issues, send };
}

test('a good send files one issue and returns its receipt; the same draft again returns the same receipt without a second issue', async () => {
  const { issues, send } = harness();
  const first = await send(payload());
  assert.equal(first.status, 201);
  assert.match(first.body.receipt, /^FB-[0-9A-Z]{4}-[0-9A-Z]{2}$/);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, `[feedback] ${first.body.receipt}`);
  const again = await send(payload());
  assert.deepEqual(again, { status: 200, body: { receipt: first.body.receipt, duplicate: true } });
  const sameText = await send(payload({ draftId: 'draft0000000000002', text: '  the CAMERA froze after approval.  ' }));
  assert.deepEqual(sameText.body, { receipt: first.body.receipt, duplicate: true });
  assert.equal(issues.length, 1);
});

test('requests that are not from a loopback page, not JSON, too large or malformed are refused before anything is counted', async () => {
  const { issues, send, ports } = harness();
  assert.deepEqual(await send(payload(), { origin: 'https://evil.example' }), { status: 403, body: { error: 'forbidden' } });
  assert.deepEqual(await send(payload(), { origin: null }), { status: 403, body: { error: 'forbidden' } });
  assert.deepEqual(await send(payload(), { contentType: 'text/plain' }), { status: 415, body: { error: 'invalid_request' } });
  assert.deepEqual(await send(payload(), { contentLength: '99999' }), { status: 413, body: { error: 'body_too_large' } });
  assert.deepEqual(await send({ ...payload(), text: 'x'.repeat(20000) }), { status: 413, body: { error: 'body_too_large' } });
  assert.deepEqual(await send('{not json'), { status: 400, body: { error: 'invalid_request' } });
  assert.deepEqual(await send(payload({ kind: 'bug' })), { status: 400, body: { error: 'invalid_request' } });
  assert.equal(issues.length, 0);
  assert.equal(ports.book.count('all', '-', '2026-11-04'), 0);
});

test('a secret shape is refused with 422 even when the panel was skipped, in the text and in the version field', async () => {
  const { issues, send } = harness();
  assert.deepEqual(await send(payload({ text: `my key is ${FAKE_SECRETS.anthropic_key}` })), { status: 422, body: { error: 'secret_detected' } });
  assert.deepEqual(await send(payload({ version: FAKE_SECRETS.github_token })), { status: 422, body: { error: 'secret_detected' } });
  assert.equal(issues.length, 0);
});

test('the same text from another sender is a new report: the duplicate check does not tell one sender about another', async () => {
  const { issues, send } = harness();
  const first = await send(payload());
  const other = await send(payload({ draftId: 'draft0000000000003' }), { ip: '198.51.100.20' });
  assert.equal(other.status, 201);
  assert.notEqual(other.body.receipt, first.body.receipt);
  assert.equal(issues.length, 2);
});

test('limits count an IPv6 sender by its /64 and an IPv4 sender by its address', () => {
  assert.equal(ipBucket('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:db8::5'), '2001:db8:0:0::/64');
  assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
  assert.equal(ipBucket(null), 'none');
});

test('the intake can be closed, and the burst limiter refuses', async () => {
  const closed = await handleFeedback({ origin: ORIGIN }, { open: false });
  assert.deepEqual(closed, { status: 503, body: { error: 'intake_closed' } });
  const { send } = harness({ burstOk: false });
  assert.deepEqual(await send(payload()), { status: 429, body: { error: 'rate_limited' } });
});

test('daily limits: 5 per install, then 429 daily_limit', async () => {
  const { send, issues } = harness();
  for (let i = 0; i < DAILY_LIMITS.install; i++) {
    const result = await send(payload({ draftId: `draft00000000000${10 + i}`, text: `report number ${i}` }));
    assert.equal(result.status, 201, `send ${i}`);
  }
  assert.deepEqual(await send(payload({ draftId: 'draft0000000000099', text: 'one more' })), { status: 429, body: { error: 'daily_limit' } });
  assert.equal(issues.length, DAILY_LIMITS.install);
});

test('a GitHub failure answers 502 and forgets the receipt, so the same draft can be sent again', async () => {
  let fail = true;
  const filed = [];
  const { send } = harness({ github: { createIssue: async (issue) => { if (fail) throw new Error('github_issue_500'); filed.push(issue); return { number: 1 }; } } });
  assert.deepEqual(await send(payload()), { status: 502, body: { error: 'intake_unavailable' } });
  fail = false;
  const retry = await send(payload());
  assert.equal(retry.status, 201);
  assert.equal(filed.length, 1);
});

test('the issue keeps the sender text in a fence longer than any backtick run, with a fixed title', () => {
  const value = { text: 'use ```js\n@someone ![x](https://t.example/p.png)\n```', version: '0.2.0 `x`' };
  const issue = issueOf(value, 'FB-0000-01', '2026-11-04T05:00:00.000Z');
  assert.equal(issue.title, '[feedback] FB-0000-01');
  assert.ok(issue.body.includes('````text\nuse ```js'));
  assert.ok(issue.body.includes('ALBERA version: `` 0.2.0 `x` ``'));
  assert.ok(!issue.title.includes('someone'));
});

function appKeys() {
  return generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
}

test('the GitHub App signs an RS256 JWT, asks for a token narrowed to one repository and Issues: write, caches it, and files the issue', async () => {
  const { privateKey, publicKey } = appKeys();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token', expires_at: new Date(NOW + 3600_000).toISOString() }, { status: 201 });
    return Response.json({ number: 42 }, { status: 201 });
  };
  const gh = createGitHubIssues({ appId: '123456', installationId: '7890', privateKeyPem: privateKey, repo: 'BERORINPO/albera-feedback', fetch: fakeFetch, now: () => NOW });
  assert.deepEqual(await gh.createIssue({ title: 't', body: 'b' }), { number: 42 });
  await gh.createIssue({ title: 't2', body: 'b2' });
  assert.equal(calls.filter((call) => call.url.endsWith('/access_tokens')).length, 1, 'the token is cached');

  const tokenCall = calls[0];
  assert.equal(tokenCall.url, 'https://api.github.com/app/installations/7890/access_tokens');
  assert.deepEqual(JSON.parse(tokenCall.init.body), { repositories: ['albera-feedback'], permissions: { issues: 'write' } });
  const jwt = tokenCall.init.headers.Authorization.replace(/^Bearer /, '');
  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const body = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(body.iss, '123456');
  assert.equal(body.exp - body.iat, 600);
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')));

  const issueCall = calls[1];
  assert.equal(issueCall.url, 'https://api.github.com/repos/BERORINPO/albera-feedback/issues');
  assert.equal(issueCall.init.headers.Authorization, 'Bearer installation-token');
});

test('the GitHub App refuses a PKCS#1 key and bad settings, and reports failures as codes only', async () => {
  assert.throws(() => pkcs8Der('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----'), /app_key_is_pkcs1/);
  const { privateKey } = appKeys();
  assert.throws(() => createGitHubIssues({ appId: 'abc', installationId: '1', privateKeyPem: privateKey, repo: 'a/b' }), /app_config_invalid/);
  const gh = createGitHubIssues({
    appId: '1', installationId: '1', privateKeyPem: privateKey, repo: 'a/b', now: () => NOW,
    fetch: async () => new Response('{"message":"secret detail"}', { status: 403 }),
  });
  await assert.rejects(() => gh.createIssue({ title: 't', body: 'b' }), (error) => error.message === 'github_token_403');
});

test('the Worker entry: one path, CORS only for loopback pages, closed while a setting is missing', async () => {
  const preflight = await worker.fetch(new Request('https://intake.example/v1/feedback', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), {});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST');

  const foreign = await worker.fetch(new Request('https://intake.example/v1/feedback', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), {});
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);

  const closed = await worker.fetch(new Request('https://intake.example/v1/feedback', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) }), { FEEDBACK_OPEN: 'true' });
  assert.equal(closed.status, 503);
  assert.deepEqual(await closed.json(), { error: 'intake_closed' });
  assert.equal(closed.headers.get('Cache-Control'), 'no-store');

  assert.equal((await worker.fetch(new Request('https://intake.example/'), {})).status, 404);
  assert.ok(isLoopbackOrigin('http://localhost:8080'));
  assert.ok(!isLoopbackOrigin('http://127.0.0.1.evil.example:80'));
});

test('the Worker entry end to end with every setting (Durable Object, burst limiter and GitHub replaced by stand-ins)', async () => {
  const { privateKey } = appKeys();
  const limits = new IntakeLimits({ storage: { sql: sqlPort() } });
  const env = {
    FEEDBACK_OPEN: 'true', APP_ID: '1', APP_INSTALLATION_ID: '2', INTAKE_REPO: 'BERORINPO/albera-feedback', APP_PRIVATE_KEY: privateKey, IP_HASH_KEY: 'k'.repeat(48),
    LIMITS: { idFromName: () => 'global', get: () => ({ fetch: (url, init) => limits.fetch(new Request(url, init)) }) },
    BURST: { limit: async () => ({ success: true }) },
  };
  const realFetch = globalThis.fetch;
  const filed = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/access_tokens')) return Response.json({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    filed.push(JSON.parse(init.body));
    return Response.json({ number: 1 }, { status: 201 });
  };
  try {
    const response = await worker.fetch(new Request('https://intake.example/v1/feedback', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify(payload()) }), env);
    assert.equal(response.status, 201);
    const { receipt } = await response.json();
    assert.equal(filed.length, 1);
    assert.equal(filed[0].title, `[feedback] ${receipt}`);
    assert.ok(!JSON.stringify(filed[0]).includes('203.0.113.9'), 'the address never reaches the issue');
  } finally {
    globalThis.fetch = realFetch;
  }
});
