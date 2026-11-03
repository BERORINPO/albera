// GitHub, as the intake's GitHub App: the only place that holds the App's private key (a Worker secret) and the only outbound call of the intake.
// The App has one repository permission, Issues: write, and is installed on the intake repository only. Each installation token is asked for with that one
// repository and that one permission again (a narrower token than the installation allows), kept in memory until 5 minutes before it expires, and never logged.
// Errors are fixed codes: no GitHub response body, no token and no key ever reaches a thrown message.

const API = 'https://api.github.com';
const APP_ID_RE = /^\d{1,12}$/;
const INSTALLATION_RE = /^\d{1,15}$/;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

/** The DER bytes of a PKCS#8 PEM. GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"), which WebCrypto cannot import: convert it once with openssl before storing. */
export function pkcs8Der(pem) {
  if (typeof pem !== 'string') throw new Error('app_key_missing');
  if (pem.includes('BEGIN RSA PRIVATE KEY')) throw new Error('app_key_is_pkcs1');
  const match = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (!match) throw new Error('app_key_invalid');
  const binary = atob(match[1].replace(/\s+/g, ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * @param {{ appId: string, installationId: string, privateKeyPem: string, repo: string, fetch?: typeof fetch, now?: () => number, subtle?: SubtleCrypto }} config
 * @returns {{ createIssue: (issue: { title: string, body: string }) => Promise<{ number: number }> }}
 */
export function createGitHubIssues({ appId, installationId, privateKeyPem, repo, fetch: send = globalThis.fetch, now = () => Date.now(), subtle = globalThis.crypto.subtle }) {
  if (!APP_ID_RE.test(String(appId)) || !INSTALLATION_RE.test(String(installationId)) || !REPO_RE.test(String(repo))) throw new Error('app_config_invalid');
  const der = pkcs8Der(privateKeyPem);
  const repoName = repo.split('/')[1];
  let keyPromise = null;
  let cached = null;

  const headers = (auth) => ({ Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'albera-feedback-intake' });

  async function appJwt() {
    keyPromise ??= subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const key = await keyPromise;
    const seconds = Math.floor(now() / 1000);
    // iat 60 s in the past for clock drift, exp within GitHub's 10-minute limit
    const unsigned = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: String(appId) }))}`;
    const signature = await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    return `${unsigned}.${b64url(signature)}`;
  }

  async function installationToken() {
    if (cached && cached.expiresAt - now() > TOKEN_MARGIN_MS) return cached.token;
    const response = await send(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { ...headers(await appJwt()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositories: [repoName], permissions: { issues: 'write' } }),
    });
    if (response.status !== 201) throw new Error(`github_token_${response.status}`);
    const body = await response.json().catch(() => null);
    const expiresAt = Date.parse(body?.expires_at ?? '');
    if (typeof body?.token !== 'string' || !Number.isFinite(expiresAt)) throw new Error('github_token_invalid');
    cached = { token: body.token, expiresAt };
    return cached.token;
  }

  async function createIssue({ title, body }) {
    const response = await send(`${API}/repos/${repo}/issues`, {
      method: 'POST',
      headers: { ...headers(await installationToken()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    if (response.status === 401) cached = null;
    if (response.status !== 201) throw new Error(`github_issue_${response.status}`);
    const created = await response.json().catch(() => null);
    return { number: Number.isInteger(created?.number) ? created.number : 0 };
  }

  return { createIssue };
}
