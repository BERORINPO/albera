// The intake's decision for one request (docs/architecture/feedback-intake.md). Every outside thing is a port: the daily book (limits.mjs in a Durable Object),
// the per-minute burst limiter (Workers rate limit binding), GitHub (github-app.mjs), the keyed hash, the digest, random bytes and the clock.
// The text is checked with the same contract as the room's panel; a secret shape is refused here even when a client skipped the panel.
// Nothing here logs, and no reply carries the text, the address or a GitHub message: replies are { receipt } or { error: <fixed code> }.
import { checkFeedback, dedupeText, findSecrets, receiptFromBytes, textsOf, FEEDBACK_MAX_REQUEST_BYTES } from '../../../src/runtime/feedback-contract.mjs';
import { issueOf } from './issue-format.mjs';

export const FEEDBACK_PATH = '/v1/feedback';
const LOOPBACK_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;
const RECEIPT_CANDIDATES = 3;

/** The room is served from 127.0.0.1 or localhost on a port chosen at start, so the origin is checked by shape, not by one value. */
export const isLoopbackOrigin = (origin) => typeof origin === 'string' && LOOPBACK_ORIGIN_RE.test(origin);

/** Headers on every reply: no caching, no sniffing, and CORS only for a loopback origin. */
export function replyHeaders(origin, preflight = false) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' };
  if (isLoopbackOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (preflight) Object.assign(headers, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
  }
  return headers;
}

/**
 * The part of an address that limits count by: an IPv4 address as is, an IPv6 address by its /64 (one subscriber usually holds a whole /64, so counting
 * per /128 would let one machine send under thousands of keys). Anything else (no header) is one shared bucket.
 */
export function ipBucket(ip) {
  if (typeof ip !== 'string' || ip.length === 0 || ip.length > 64) return 'none';
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

const fail = (status, error) => ({ status, body: { error } });
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {{ origin: string|null, contentType: string|null, contentLength: string|null, ip: string|null, readBody: (max: number) => Promise<Uint8Array|null> }} request
 *   readBody resolves null when the body is longer than `max`.
 * @param {{ open: boolean, book: { admit: Function, settle: Function }, burst: { limit: Function }, github: { createIssue: Function },
 *   hmac: (text: string) => Promise<string>, sha256: (text: string) => Promise<string>, randomBytes: (n: number) => Uint8Array, now: () => number }} ports
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleFeedback(request, ports) {
  if (!isLoopbackOrigin(request.origin)) return fail(403, 'forbidden');
  if (!ports.open) return fail(503, 'intake_closed');
  if (!/^application\/json(?:\s*;|$)/i.test(request.contentType ?? '')) return fail(415, 'invalid_request');
  const declared = request.contentLength;
  if (declared !== null && declared !== undefined && !(/^\d{1,9}$/.test(declared) && Number(declared) <= FEEDBACK_MAX_REQUEST_BYTES)) return fail(413, 'body_too_large');
  const bytes = await request.readBody(FEEDBACK_MAX_REQUEST_BYTES);
  if (bytes === null) return fail(413, 'body_too_large');

  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(400, 'invalid_request'); }
  const checked = checkFeedback(payload);
  if (!checked.ok) return fail(400, checked.code);
  const value = checked.value;
  if (textsOf(value).some((text) => findSecrets(text).length > 0)) return fail(422, 'secret_detected');

  const now = ports.now();
  const day = dayOf(now);
  // The address is kept only as a keyed hash that changes every day; the raw address is never stored or sent on.
  const ipKey = await ports.hmac(`ip|${day}|${ipBucket(request.ip)}`);
  const burst = await ports.burst.limit({ key: ipKey });
  if (!burst?.success) return fail(429, 'rate_limited');

  const contentHash = await ports.sha256(dedupeText(value.text));
  const candidates = Array.from({ length: RECEIPT_CANDIDATES }, () => receiptFromBytes(ports.randomBytes(4)));
  const admitted = await ports.book.admit({ day, now, ipKey, installKey: value.installDay, draftId: value.draftId, contentHash, candidates });
  if (admitted.state === 'duplicate') return { status: 200, body: { receipt: admitted.receipt, duplicate: true } };
  if (admitted.state !== 'new') return fail(admitted.code === 'daily_limit' ? 429 : 503, admitted.code === 'daily_limit' ? 'daily_limit' : 'intake_busy');

  const receipt = admitted.receipt;
  try {
    await ports.github.createIssue(issueOf(value, receipt, new Date(now).toISOString()));
  } catch {
    await ports.book.settle({ receipt, ok: false });
    return fail(502, 'intake_unavailable');
  }
  await ports.book.settle({ receipt, ok: true });
  return { status: 201, body: { receipt } };
}
