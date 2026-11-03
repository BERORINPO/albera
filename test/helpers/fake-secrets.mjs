// Synthetic look-alikes of secret shapes for the feedback tests. None of them is a real credential.
// Each one is put together at run time (pieces joined), so no token-shaped literal is committed: GitHub push protection reads committed text and
// refused a literal look-alike on 2026-11-04. Keep it that way when adding one.
const join = (...parts) => parts.join('');

/** One look-alike per rule of SECRET_RULES, keyed by the rule's code. */
export const FAKE_SECRETS = Object.freeze({
  anthropic_key: join('sk-a', 'nt-oat01-DEMO0not0a0real0key0Xq7Lm2Pz9Rt4Vw8Yb1Cd5Fg0Hj3Kn6Ms9Qu2Wx5Za8'),
  openai_key: join('sk-p', 'roj-DEMO0000not0real0000abcdefghij0123456789'),
  github_token: join('gh', 'p_DEMO0not0real0000000000000000000000'),
  slack_token: join('xo', 'xb-1234567890-DEMOnotreal'),
  aws_key: join('AK', 'IADEMO0NOTREAL0000'),
  google_key: join('AI', 'zaDEMO0not0real0000000000000000000000'),
  stripe_key: join('sk_', 'live_DEMO0not0real000000'),
  private_key: join('-----BEGIN PRIV', 'ATE KEY-----\nMIIEvQIBADANDEMO\n-----END PRIV', 'ATE KEY-----'),
  jwt: join('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'JzdWIiOiJkZW1vIn0.c2lnbmF0dXJl'),
  gitlab_token: join('gl', 'pat-DEMO0not0real0000000'),
  groq_key: join('gs', 'k_', 'D'.repeat(20), '0'.repeat(32)),
  xai_key: join('xa', 'i-', 'D'.repeat(20), '0'.repeat(60)),
  huggingface_token: join('h', 'f_', 'Demo'.repeat(9)),
  npm_token: join('np', 'm_', 'D0'.repeat(18)),
  aws_secret: join('aws_secret_', 'access_key = DEMO0not0real0000000000000000000000000000'),
  google_oauth: join('GOC', 'SPX-DEMO0not0real0000000000'),
  sendgrid_key: join('S', 'G.DEMO0not0real000000.DEMO0not0real000000'),
  url_password: 'postgres://app:hunter2@', // the range ends at the @: the host after it is not secret
  auth_header: join('Authorization: Bea', 'rer DEMOnotRealToken0123456789'),
});

/** Other shapes of the same families (each is found once). */
export const FAKE_SECRETS_MORE = Object.freeze([
  join('xo', 'xe-1-DEMOnotreal00'),
  join('wh', 'sec_DEMO0not0real0000000000000'),
  join('ya', '29.DEMO0not0real000000000000'),
  join('-----BEGIN PGP PRIV', 'ATE KEY BLOCK-----\nDEMO\n-----END PGP PRIV', 'ATE KEY BLOCK-----'),
  'https://user:pa55@example.com/x',
  join('authorization: ba', 'sic dXNlcjpwYXNzd29yZA=='),
]);
