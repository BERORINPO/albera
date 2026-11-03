// The intake Worker (docs/architecture/feedback-intake.md): wiring only. One route, POST /v1/feedback (and its CORS preflight); everything else is 404.
// Settings come from the Worker's environment: FEEDBACK_OPEN ("true" to accept), APP_ID, APP_INSTALLATION_ID, INTAKE_REPO (text), APP_PRIVATE_KEY and
// IP_HASH_KEY (secrets), LIMITS (the Durable Object of limits.mjs), BURST (rate limit binding). A missing setting closes the intake (503 intake_closed).
import { FEEDBACK_PATH, handleFeedback, replyHeaders } from './intake.mjs';
import { createGitHubIssues } from './github-app.mjs';
import { bookClient } from './limits.mjs';

export { IntakeLimits } from './limits.mjs';

let github = null;
let githubFor = null;

/** GitHub client for this isolate, made once per key and settings (the installation token is cached inside it). null when a setting is missing or bad. */
function githubOf(env) {
  const signature = `${env.APP_ID}|${env.APP_INSTALLATION_ID}|${env.INTAKE_REPO}|${typeof env.APP_PRIVATE_KEY === 'string' ? env.APP_PRIVATE_KEY.length : 0}`;
  if (githubFor !== signature) {
    githubFor = signature;
    try {
      github = createGitHubIssues({ appId: env.APP_ID, installationId: env.APP_INSTALLATION_ID, privateKeyPem: env.APP_PRIVATE_KEY, repo: env.INTAKE_REPO });
    } catch {
      github = null;
    }
  }
  return github;
}

async function hmacOf(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Of(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The body, or null as soon as it passes `max` bytes (the stream is cancelled, the rest is never read). */
async function readLimited(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const { pathname } = new URL(request.url);
    if (pathname !== FEEDBACK_PATH) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: replyHeaders(null) });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: replyHeaders(origin, true) });
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 405, headers: { ...replyHeaders(origin), Allow: 'POST, OPTIONS' } });

    const gh = githubOf(env);
    const open = env.FEEDBACK_OPEN === 'true' && gh !== null && typeof env.IP_HASH_KEY === 'string' && env.IP_HASH_KEY.length >= 32 && Boolean(env.LIMITS) && Boolean(env.BURST);
    let result;
    try {
      result = await handleFeedback({
        origin,
        contentType: request.headers.get('Content-Type'),
        contentLength: request.headers.get('Content-Length'),
        ip: request.headers.get('CF-Connecting-IP'),
        readBody: (max) => readLimited(request, max),
      }, open ? {
        open,
        book: bookClient(env.LIMITS),
        burst: env.BURST,
        github: gh,
        hmac: (text) => hmacOf(env.IP_HASH_KEY, text),
        sha256: sha256Of,
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
        now: () => Date.now(),
      } : { open: false });
    } catch {
      result = { status: 503, body: { error: 'intake_busy' } };
    }
    return new Response(JSON.stringify(result.body), { status: result.status, headers: replyHeaders(origin) });
  },
};
