// The intake's daily book: how many sends today (in all, per address key, per install key), and which receipts were given for which draft and which text.
// One Durable Object named "global" holds it (SQLite storage, available on the Workers Free plan), so every check-and-count runs one at a time.
// Stored per send: the receipt, the hash of the folded text, the address key, the draft id and the time; per day: counts under keyed hashes. No text, no raw address.
// The same text counts as "again" only from the same address key (another sender cannot learn whether a text was already sent).
// Rows older than two days are dropped on every admit.

export const DAILY_LIMITS = Object.freeze({ all: 200, ip: 10, install: 5 });
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 48 * 60 * 60 * 1000;
const PENDING_MS = 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counts (scope TEXT NOT NULL, key TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (scope, key, day));
CREATE TABLE IF NOT EXISTS receipts (receipt TEXT PRIMARY KEY, content_hash TEXT NOT NULL, ip_key TEXT NOT NULL, draft_id TEXT NOT NULL, state TEXT NOT NULL, created_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS receipts_content ON receipts (content_hash);
CREATE INDEX IF NOT EXISTS receipts_draft ON receipts (draft_id);`;

/**
 * The book over a SQL port with Durable Objects' shape: exec(query, ...bindings) -> { toArray() } (ctx.storage.sql, or a node:sqlite stand-in in tests).
 */
export class LimitsBook {
  constructor(sql) {
    this.sql = sql;
    this.sql.exec(SCHEMA);
  }

  count(scope, key, day) {
    return this.sql.exec('SELECT n FROM counts WHERE scope = ? AND key = ? AND day = ?', scope, key, day).toArray()[0]?.n ?? 0;
  }

  bump(scope, key, day) {
    this.sql.exec('INSERT INTO counts (scope, key, day, n) VALUES (?, ?, ?, 1) ON CONFLICT (scope, key, day) DO UPDATE SET n = n + 1', scope, key, day);
  }

  /**
   * @param {{ day: string, now: number, ipKey: string, installKey: string, draftId: string, contentHash: string, candidates: string[] }} input
   * @returns {{ state: 'new'|'duplicate', receipt: string } | { state: 'limited', code: 'daily_limit'|'intake_busy' }}
   */
  admit({ day, now, ipKey, installKey, draftId, contentHash, candidates }) {
    this.sql.exec('DELETE FROM receipts WHERE created_ms < ?', now - KEEP_MS);
    this.sql.exec('DELETE FROM counts WHERE day < ?', new Date(now - KEEP_MS).toISOString().slice(0, 10));
    this.sql.exec("DELETE FROM receipts WHERE state = 'pending' AND created_ms < ?", now - PENDING_MS);

    const since = now - DUPLICATE_WINDOW_MS;
    const same = this.sql.exec('SELECT receipt, state FROM receipts WHERE (draft_id = ? OR (content_hash = ? AND ip_key = ?)) AND created_ms >= ? ORDER BY created_ms', draftId, contentHash, ipKey, since).toArray();
    const done = same.find((row) => row.state === 'done');
    if (done) return { state: 'duplicate', receipt: done.receipt };
    // The same draft or text is being filed right now (a second click, a retry): do not file it twice.
    if (same.length > 0) return { state: 'limited', code: 'intake_busy' };

    if (this.count('all', '-', day) >= DAILY_LIMITS.all) return { state: 'limited', code: 'intake_busy' };
    if (this.count('ip', ipKey, day) >= DAILY_LIMITS.ip || this.count('install', installKey, day) >= DAILY_LIMITS.install) return { state: 'limited', code: 'daily_limit' };

    const receipt = candidates.find((candidate) => this.sql.exec('SELECT 1 AS one FROM receipts WHERE receipt = ?', candidate).toArray().length === 0);
    if (!receipt) return { state: 'limited', code: 'intake_busy' };
    this.sql.exec("INSERT INTO receipts (receipt, content_hash, ip_key, draft_id, state, created_ms) VALUES (?, ?, ?, ?, 'pending', ?)", receipt, contentHash, ipKey, draftId, now);
    // A send counts when it is admitted, also when GitHub then fails: a broken intake must not turn into unlimited retries.
    this.bump('all', '-', day);
    this.bump('ip', ipKey, day);
    this.bump('install', installKey, day);
    return { state: 'new', receipt };
  }

  /** ok: the issue exists, later sends of the same draft or text get this receipt. Not ok: forget the receipt so the sender can try again. */
  settle({ receipt, ok }) {
    if (ok) this.sql.exec("UPDATE receipts SET state = 'done' WHERE receipt = ?", receipt);
    else this.sql.exec("DELETE FROM receipts WHERE receipt = ? AND state = 'pending'", receipt);
    return { ok: true };
  }
}

/** The Durable Object: POST /admit and POST /settle with JSON, answered by the book. Only the intake Worker reaches it (no public route). */
export class IntakeLimits {
  constructor(ctx) {
    this.book = new LimitsBook(ctx.storage.sql);
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    let input;
    try { input = await request.json(); } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
    if (request.method === 'POST' && pathname === '/admit') return Response.json(this.book.admit(input));
    if (request.method === 'POST' && pathname === '/settle') return Response.json(this.book.settle(input));
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
}

/** The intake's view of the Durable Object: the same admit / settle as the book, over its stub. */
export function bookClient(namespace) {
  const stub = namespace.get(namespace.idFromName('global'));
  const post = async (path, input) => {
    const response = await stub.fetch(`https://limits${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error('limits_failed');
    return response.json();
  };
  return { admit: (input) => post('/admit', input), settle: (input) => post('/settle', input) };
}
