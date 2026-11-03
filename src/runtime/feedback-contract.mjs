// In-app feedback (docs/architecture/feedback-intake.md): the request the room's feedback panel sends and the secret shapes that stop it.
// One file for both sides: the room's panel imports it in the browser (room-host.mjs serves it as /room/feedback-contract.mjs) and the intake Worker
// (services/feedback-intake/) bundles it, so the panel and the Worker refuse exactly the same shapes. It lives in src/runtime because the Control Plane app tree
// is src/runtime only. Pure: no I/O, no clock, no words (codes only; the panel's words-feedback.mjs says them in en and ja). arch rule 5e checks it.

/**
 * Where the panel sends. The only cross-origin address in the room: room-host.mjs adds exactly this origin to the CSP connect-src when feedback is on.
 * PLACEHOLDER until the intake is deployed (.invalid never resolves, so a send fails as unreachable); the deploy sets the workers.dev address here.
 */
export const FEEDBACK_ENDPOINT = 'https://albera-feedback.invalid/v1/feedback';
export const FEEDBACK_ORIGIN = new URL(FEEDBACK_ENDPOINT).origin;
export const FEEDBACK_VERSION = 1;
export const FEEDBACK_MAX_CHARS = 4000;
/** The whole request, JSON. 4000 characters of text are at most 12000 bytes of UTF-8; the rest is room for the fields and JSON escapes. */
export const FEEDBACK_MAX_REQUEST_BYTES = 16 * 1024;

/** Every code a send can end with. The panel has words for each; anything else is shown as `intake_unavailable`. */
export const FEEDBACK_RESULT_CODES = Object.freeze([
  'created', 'duplicate',
  'invalid_request', 'empty_text', 'text_too_long', 'unsafe_text', 'body_too_large', 'forbidden',
  'secret_detected', 'rate_limited', 'daily_limit', 'intake_busy', 'intake_closed', 'intake_unavailable',
]);

// No letter, digit, '_' or '-' right before a short or common prefix, so "task-start-attestation" is not read as an "sk-" key. A prefix that cannot occur
// inside an ordinary word (sk-ant-, github_pat_, glpat-, GOCSPX-, ...) has no such guard, so "APIKEYsk-ant-..." is still found.
const B = '(?<![A-Za-z0-9_-])';
const rule = (code, source, flags = 'g') => Object.freeze({ code, re: new RegExp(source, flags) });

/**
 * Shapes that are secrets. Found in the text, the panel marks them and will not send until they are deleted, and the Worker refuses the request
 * (422 secret_detected). Order matters: a specific shape comes before a general one, and a later rule never reports a string an earlier rule found.
 * Adding a shape is a reversible strengthening (decided without the owner, reported after); removing or loosening one needs the owner.
 */
export const SECRET_RULES = Object.freeze([
  rule('anthropic_key', 'sk-ant-[A-Za-z0-9_-]{8,}'),
  rule('openai_key', `${B}sk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}`),
  rule('github_token', '(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})'),
  rule('gitlab_token', 'glpat-[A-Za-z0-9_-]{20,}'),
  rule('groq_key', `${B}gsk_[A-Za-z0-9]{40,}`),
  rule('xai_key', `${B}xai-[A-Za-z0-9]{40,}`),
  rule('huggingface_token', `${B}hf_[A-Za-z]{30,}`),
  rule('npm_token', `${B}npm_[A-Za-z0-9]{36,}`),
  rule('slack_token', `${B}xox[abposre]-[0-9]+-[A-Za-z0-9-]{6,}`),
  rule('aws_key', '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b'),
  rule('aws_secret', 'aws_secret_access_key\\s*[:=]\\s*["\']?[A-Za-z0-9/+=]{20,}', 'gi'),
  rule('google_key', 'AIza[0-9A-Za-z_-]{35}'),
  rule('google_oauth', '(?:GOCSPX-[A-Za-z0-9_-]{20,}|ya29\\.[A-Za-z0-9_-]{20,})'),
  rule('stripe_key', `${B}(?:[rs]k_live_[0-9A-Za-z]{16,}|whsec_[A-Za-z0-9+/=]{24,})`),
  rule('sendgrid_key', `${B}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`),
  rule('private_key', '-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)'),
  rule('jwt', `${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]*`),
  // a password in a URL (scheme://user:password@host) and a credential in an Authorization header, as pasted from a connection string or a log.
  // The scheme starts at a word start and every part has a length cap, so a long run of letters is scanned in linear time (the Worker has 10 ms of CPU).
  rule('url_password', '(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}://[^\\s/:@]{1,256}:[^\\s/@]{1,256}@'),
  rule('auth_header', 'Authorization\\s*:\\s*(?:Bearer|Basic|token)\\s+[A-Za-z0-9._~+/=-]{8,}', 'gi'),
]);

/**
 * Where secret shapes are in the text: [{ code, start, end }], sorted, never overlapping (a match that overlaps an earlier rule's match is dropped, so one
 * string is reported once). The panel paints these ranges and stops the send; the Worker refuses the request when there is any.
 */
export function secretRanges(text) {
  const source = typeof text === 'string' ? text : '';
  const taken = [];
  for (const { code, re } of SECRET_RULES) {
    for (const match of source.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (end > start && !taken.some((range) => start < range.end && range.start < end)) taken.push(Object.freeze({ code, start, end }));
    }
  }
  return Object.freeze(taken.sort((x, y) => x.start - y.start));
}

/** [{ code, length }] of every secret shape in the text, each string once. */
export const findSecrets = (text) => Object.freeze(secretRanges(text).map(({ code, start, end }) => Object.freeze({ code, length: end - start })));

// C0 and C1 controls (but tab and line feed), soft hyphen and other invisible fillers, zero-width and direction marks, line and paragraph separators, BOM
// and tag characters: a reader cannot see what they do (tag characters can carry hidden instructions to an AI that reads the issue).
const UNSAFE_TEXT_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u115f\u1160\u180e\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u2069\u3164\uffa0\ufeff\u{e0000}-\u{e007f}]/u;
// A zero-width joiner is allowed only between two pictographs (it joins emoji); anywhere else it hides a break, for example inside a key.
const LONE_ZWJ_RE = /(?<!\p{Extended_Pictographic}\ufe0f?)\u200d|\u200d(?!\p{Extended_Pictographic})/u;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const hasExactly = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Line ends as \n only, no trailing white space at the ends. Done before any check so the panel and the Worker look at the same text. */
export const normalizeText = (text) => (typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '');

/** The version string the room host reports: printable ASCII, 1 to 64 characters. */
export const isVersion = (value) => typeof value === 'string' && /^[ -~]{1,64}$/.test(value);

/**
 * The request: { v: 1, text, draftId, installDay, version }. Nothing else is sent (owner, 2026-11-04: the sender needs no choices and no diagnostics box).
 * `draftId` is the panel's random id of one draft (the same draft sent twice gets the same receipt); `installDay` is the panel's day-scoped id (HMAC of a
 * random install secret and the date, so two days of one install cannot be linked); `version` is the ALBERA version the room host reports (not a secret,
 * and needed to reproduce a bug).
 * Returns { ok: true, value } with only these fields (normalized text, frozen), or { ok: false, code } with a code from FEEDBACK_RESULT_CODES.
 * It does not look for secrets: secretRanges is a separate step on both sides, so a caller can tell `secret_detected` from a malformed request.
 */
export function checkFeedback(payload) {
  if (!isPlainObject(payload) || !hasExactly(payload, ['v', 'text', 'draftId', 'installDay', 'version'])) return { ok: false, code: 'invalid_request' };
  if (payload.v !== FEEDBACK_VERSION) return { ok: false, code: 'invalid_request' };
  if (typeof payload.draftId !== 'string' || !TOKEN_RE.test(payload.draftId) || typeof payload.installDay !== 'string' || !TOKEN_RE.test(payload.installDay)) {
    return { ok: false, code: 'invalid_request' };
  }
  if (!isVersion(payload.version) || typeof payload.text !== 'string') return { ok: false, code: 'invalid_request' };
  const text = normalizeText(payload.text);
  if (text.length === 0) return { ok: false, code: 'empty_text' };
  if (text.length > FEEDBACK_MAX_CHARS) return { ok: false, code: 'text_too_long' };
  if (UNSAFE_TEXT_RE.test(text) || LONE_ZWJ_RE.test(text)) return { ok: false, code: 'unsafe_text' };
  return { ok: true, value: Object.freeze({ v: FEEDBACK_VERSION, text, draftId: payload.draftId, installDay: payload.installDay, version: payload.version }) };
}

/** Every string of a checked request that a secret could hide in, for the Worker's check. */
export const textsOf = (value) => [value.text, value.version];

/** The text two sends are compared by for "the same feedback again": compatibility-normalized, white space folded, lower case. */
export const dedupeText = (text) => normalizeText(text).normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECEIPT_RE = /^FB-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/;

/** A receipt number such as FB-7K3Q-2M from 4 random bytes (the first 30 bits, Crockford base32). The Worker draws the bytes and checks that the number is unused. */
export function receiptFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) throw new TypeError('receipt_needs_4_bytes');
  let bits = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 2;
  const chars = [];
  for (let i = 0; i < 6; i++) {
    chars.unshift(CROCKFORD[bits & 31]);
    bits >>>= 5;
  }
  return `FB-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
