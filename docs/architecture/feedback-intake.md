# In-app feedback intake

**Status: owner-approved 2026-11-04 (recommended plan), implemented in parts, NOT VERIFIED against Cloudflare or GitHub.** The intake Worker is not deployed yet and the GitHub App does not exist yet; both are owner steps (section 7). Until the intake address is known, the room's feedback panel stays off (`feedback-contract.mjs` holds a `.invalid` placeholder).

## 要約 (株主向け)

1. room の「ご意見」は入力欄 1 つと送るボタンだけ。送ったら「届きました (受付番号 FB-xxxx-xx)」を 1 行出して閉じる。送るのは書いた文と ALBERA の版番号だけ (株主の指示 2026-11-04)。
2. 文は**利用者のブラウザから**受付 (Cloudflare Worker) へ送られ、GitHub App が**非公開の受付 repo** `BERORINPO/albera-feedback` に issue を作る。送る人に GitHub アカウントは要らない。
3. 秘密は 2 段で止める。画面は入力のたびに裏でキーの形を探し、引っかかったときだけ該当箇所を赤く強調して送信を止める (伏せ字にして送ることはしない)。受付でも同じ規則で検査して断る。規則は `src/runtime/feedback-contract.mjs` の 1 ファイルで、両方が同じものを使う。
4. Control Plane サービスは外へ通信しない (資格情報を持つため)。送るのは利用者が押したときのブラウザだけ。
5. 公開 repo へは移さない (GitHub は非公開 repo の issue を公開 repo へ移せない)。運営が読んで、個人の情報を除いた要約を公開 repo に新しく書く。

## 1. Flow

```
room page (browser) --GET api/feedback--> room host (Control Plane): endpoint + the ALBERA version; the service itself sends nothing out
room page (browser) --POST https://<intake>/v1/feedback--> intake Worker --GitHub App (Issues: write, one repository)--> BERORINPO/albera-feedback (private)
                                                                                      triage by a person --> a new, rewritten issue in BERORINPO/albera (public)
```

## 2. Request contract (`src/runtime/feedback-contract.mjs`)

`{ v: 1, text, draftId, installDay, version }`, JSON, at most 16 KiB. Nothing else: no kind, no diagnostics (owner, 2026-11-04).

| Field | Rule |
|---|---|
| `text` | Line ends folded to `\n`, trimmed, 1 to 4000 characters. Refused: C0/C1 controls (except tab and line feed), zero-width and direction marks, line/paragraph separators, BOM (`unsafe_text`) |
| `draftId` | The panel's random id of one draft (16 random bytes, base64url). The same draft sent twice gets the same receipt |
| `installDay` | HMAC-SHA256 of a random install secret (browser storage of that PC) and the UTC date. Changes every day, so two days of one install cannot be linked |
| `version` | The ALBERA version the room host reports, printable ASCII up to 64. Not a secret, and needed to reproduce a bug. No OS, error list, VM name, task text, path or user name is sent |

Replies: `201 { receipt }`, `200 { receipt, duplicate: true }`, or `{ error }` with a code from `FEEDBACK_RESULT_CODES`. A receipt looks like `FB-7K3Q-2M` (30 random bits, Crockford base32).

## 3. Secrets

| Shapes | Panel | Worker |
|---|---|---|
| Keys with a known prefix: Anthropic `sk-ant-`, OpenAI `sk-` (32+, with a digit), GitHub `gh?_` / `github_pat_`, GitLab `glpat-`, Groq `gsk_`, xAI `xai-`, Hugging Face `hf_`, npm `npm_`, Slack `xox?-<digits>-`, AWS `AKIA` / `ASIA` and `aws_secret_access_key=`, Google `AIza` / `GOCSPX-` / `ya29.`, Stripe `sk_live_` / `rk_live_` / `whsec_`, SendGrid `SG.`, PEM and PGP private keys, JWTs. Without a prefix: a password in a URL (`scheme://user:pass@`) and an `Authorization:` header credential | Checks on every keystroke and shows nothing until a shape is found; then marks the found range red, says "delete it, then send", and keeps the send button off. No mask button: the sender deletes it | Refuses with 422 `secret_detected` (text and version) |

A short or common prefix must not follow a letter, digit, `_` or `-`, so `task-start-attestation` is not an `sk-` key; a prefix that cannot be part of a word (`sk-ant-`, `github_pat_`, `glpat-`, ...) has no such guard. Every rule runs in linear time on 4000 characters (the Worker has 10 ms of CPU). Invisible characters (`unsafe_text`) include soft hyphens, fillers and Unicode tag characters (a hidden channel to an AI that reads the issue); a zero-width joiner is allowed only inside an emoji. `secretRanges` returns sorted, non-overlapping ranges, so one string is reported once. E-mail addresses and paths are not checked: what to write is the sender's call. Adding a shape is a reversible strengthening (Velo decides and reports); removing or loosening one needs the owner.

## 4. Abuse limits (Provisional numbers)

| Limit | Value | Where |
|---|---|---|
| Request size | 16 KiB (declared and actual) | Worker |
| Burst | 3 a minute per address key, per Cloudflare location (approximate) | Workers rate limit binding |
| Per install | 5 a day (`installDay`) | Durable Object (SQLite) |
| Per address | 10 a day (IPv4 per address, IPv6 per /64) | Durable Object |
| All senders | 200 a day, then `intake_busy` | Durable Object |
| Duplicates | Same `draftId`, or the same folded text from the same address key, within 24 h: the earlier receipt, no new issue (another sender cannot learn whether a text was sent) | Durable Object |

The address is used only as `HMAC(IP_HASH_KEY, day | address)`. The Durable Object keeps receipts, text hashes, draft ids and daily counts for 48 hours; it never holds text or a raw address. A send counts when admitted, also if GitHub then fails (no unlimited retries); a failed send forgets its receipt so the same draft can be sent again.

## 5. Issue shape

Title `[feedback] <receipt>`: no sender text in a title. The sender's text is in a fenced block whose fence is longer than any backtick run in it, so mentions, links and images do nothing; the version in an inline code span. No labels (the App has no other permission). Not in the issue: the address, the install id, a user name.

## 6. The Worker (`services/feedback-intake/`)

| File | Role |
|---|---|
| `src/index.mjs` | Entry: one path, `POST /v1/feedback` and its preflight. CORS only for `http://127.0.0.1:<port>` and `http://localhost:<port>`. `Cache-Control: no-store`. A missing setting closes the intake (`503 intake_closed`) |
| `src/intake.mjs` | The decision, over injected ports (book, burst, GitHub, keyed hash, digest, random, clock) |
| `src/limits.mjs` | `LimitsBook` (SQL port) and the `IntakeLimits` Durable Object around it |
| `src/github-app.mjs` | RS256 App JWT with WebCrypto, an installation token narrowed to the one repository and `issues: write`, cached until 5 minutes before expiry; errors are fixed codes |
| `src/issue-format.mjs` | Title and body |
| `wrangler.jsonc` | Name `albera-feedback`, workers.dev, the Durable Object (SQLite, Free plan), the rate limit binding, request logs off |

No package is added to the repository. Tests run on Node with stand-ins (`test/feedback-intake*.test.mjs`): node:sqlite for the Durable Object's SQL, recorded fetch for GitHub, keys generated in the test. They prove the decisions and the request shapes, not Cloudflare's runtime or GitHub.

## 7. Owner steps (cards in the ledger)

1. Create the GitHub App from the prefilled page (no webhook, private, Repository permission Issues: Read and write; GitHub adds Metadata: read to every App), generate a private key (downloads a `.pem`), install it on `BERORINPO/albera-feedback` only. Note the App ID and the installation id (the number at the end of the installation's settings address).
2. `pwsh scripts/feedback-intake-deploy.ps1 -PemPath <.pem> -AppId <id> -InstallationId <id>`: first use downloads Wrangler 4.151.3 into the npm cache (about 150 MB) and opens the Cloudflare login in the browser. It deploys, puts the four secrets (the key converted to PKCS#8 in memory; `IP_HASH_KEY` fresh random), checks the preflight (204) and an empty POST (400), and prints the intake address.
3. Delete the `.pem`. Give Velo the printed address: Velo puts it in `FEEDBACK_ENDPOINT` and turns the room's feedback on by default.

Closing the intake: set `FEEDBACK_OPEN` to `"false"` in `wrangler.jsonc` and deploy, or uninstall the App (nothing can be filed from that moment).

## 8. Not verified

- The Worker on Cloudflare: the Durable Object without the `DurableObject` base class (fetch interface), the rate limit binding, the Free plan's 10 ms CPU with one RS256 signature per hour.
- GitHub: token narrowing to one repository on a personal account's App, and the issue creation itself.
- Browsers: the room page (127.0.0.1) posting to a public https origin with CORS, under the room's CSP with that one origin added.

## 9. Rejected

| Alternative | Why not |
|---|---|
| The Control Plane service sends | It holds the credentials; an outbound path from it is a way out for a secret after one bug |
| Filing in the public repository directly | Raw feedback may carry personal details; a private issue cannot be moved to a public repository later |
| E-mail (`mailto:`), then filing by hand | Shows the sender's address, needs a mail app, only the panel could check secrets |
| A form service (Google Forms and the like) | Outside the app: no secret check, the text stays with a third party |
| The first panel (kind, three steps, full preview, diagnostics box, masking) | The owner found it was more than a sender needs (2026-11-04); `design-v1` in the mock folder |
| A fine-grained personal token instead of an App | Acts as the owner's account, expires, wider than one repository's Issues |
| Turnstile in the room | A third-party script in the room's CSP. Kept as the escalation if abuse comes (on a Worker page, not in the room) |
| `cf deploy` with `cloudflare.config.ts` | `cf` builds only through Wrangler or the Vite plugin declared in the project; that would add a dependency to the repository. A pinned `npx wrangler` from the owner's console adds none |
