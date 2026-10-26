// @ts-check
// entry: HTTP の受け口。横断的なヘッダーは全レスポンスに一括で付ける。spec/board.md §12
// Host 検査 (DNS rebinding 対策) → 読み取りAPIは GET のみ、明示的な worktree 作成だけ POST → 起動時の配信表。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELLO_PATH, helloBody } from './probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = 'text/javascript; charset=utf-8';
const WORKTREE_PATH = '/api/worktrees';
const DELEGATION_PATH = '/api/delegations';
const DELEGATION_BODY_MAX = 4096;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKTREE_BODY_MAX = 2048;
const MAX_WORKTREE_ITEMS = 20;
const SESSION_CARD_ID = /^(?:local|codex|copilot|opencode)_[0-9a-f-]{36}$/i;
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

/** 配信してよい拡張子と Content-Type。 */
export const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': JS,
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});
/** 画面にも配信する shared のファイル (画面は ../src/shared/... で import する)。 */
const SHARED_FILES = Object.freeze(['constants.mjs', 'i18n.mjs']);
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** @typedef {Map<string, {file: string, type: string}>} StaticTable */

/**
 * 配信表を作る (起動時に 1 回)。public/ 直下のファイルのうち、決まった拡張子のものだけをファイル名そのままの /<name> で配信する。
 * サブフォルダ・dotfile・シンボリックリンクは入れない。/ は index.html。加えて shared の 2 ファイル。
 * @param {{publicDir?: string, sharedDir?: string}} [dirs]
 * @returns {StaticTable}
 */
export function buildStaticFiles({ publicDir = path.join(ROOT, 'public'), sharedDir = path.join(ROOT, 'src', 'shared') } = {}) {
  /** @type {StaticTable} */
  const table = new Map();
  /** @type {fs.Dirent[]} */
  let ents = [];
  try {
    ents = fs.readdirSync(publicDir, { withFileTypes: true });
  } catch {
    ents = []; // 無ければ空 (全部 404)
  }
  for (const e of ents) {
    if (!e.isFile() || !SAFE_NAME_RE.test(e.name)) continue;
    const type = STATIC_TYPES[/** @type {keyof typeof STATIC_TYPES} */ (path.extname(e.name).toLowerCase())];
    if (type) table.set(`/${e.name}`, { file: path.join(publicDir, e.name), type });
  }
  const index = table.get('/index.html');
  if (index) table.set('/', index);
  for (const name of SHARED_FILES) {
    const file = path.join(sharedDir, name);
    if (fs.existsSync(file)) table.set(`/src/shared/${name}`, { file, type: JS });
  }
  return table;
}

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} type
 * @param {string|Buffer} body
 */
function send(res, status, type, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(body);
}

/**
 * @param {{port: number, getBoard: () => Promise<{body: string, etag: string}>, createWorktree?:(sessionId:string,branch:string)=>Promise<any>, listWorktrees?:(sessionId:string)=>Promise<any>, removeWorktree?:(sessionId:string,branch:string,confirmed:boolean)=>Promise<any>, demo?: boolean,
 *   log?: (key: string, params?: Record<string, unknown>) => void, staticFiles?: StaticTable}} deps
 *   log は messages.mjs のキーで受ける (言葉は server が付ける)。demo は /api/hello で答える (ポートが使用中のときの確かめ用)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler({ port, getBoard, createWorktree, listWorktrees, removeWorktree, startDelegation, getDelegationStatus, demo = false, log = () => {}, staticFiles = buildStaticFiles() }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    const pathname = String(req.url ?? '/').split('?')[0];
    if (pathname === `${DELEGATION_PATH}/run`) {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed'); }
      return serveDelegation(req, res, host);
    }
    if (pathname.startsWith(`${DELEGATION_PATH}/status/`)) {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed'); }
      const id = pathname.slice(`${DELEGATION_PATH}/status/`.length);
      if (!OPERATION_ID.test(id) || String(req.url ?? '').includes('?')) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' }));
      const status = getDelegationStatus?.(id);
      return ['running', 'completed', 'failed'].includes(status) ? send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ status })) : send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'operation_unavailable' }));
    }
    if (pathname === WORKTREE_PATH) {
      if (req.method === 'GET') return serveWorktreeList(req, res, host);
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
      }
      return serveWorktree(req, res);
    }
    if (pathname === `${WORKTREE_PATH}/remove`) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
      }
      return serveWorktreeRemoval(req, res);
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
    }
    if (pathname === '/api/board') return serveBoard(req, res);
    if (pathname === HELLO_PATH) return send(res, 200, 'application/json; charset=utf-8', helloBody(demo));
    const entry = staticFiles.get(pathname);
    if (!entry) return send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    try {
      send(res, 200, entry.type, await fsp.readFile(entry.file));
    } catch {
      send(res, 500, 'text/plain; charset=utf-8', 'Internal Server Error');
    }
  };

  /** A bounded, same-origin request. Purpose text is never logged, echoed, or persisted here. */
  async function serveDelegation(req, res, host) {
    const origin = String(req.headers.origin ?? '');
    if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'origin_rejected' }));
    if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return send(res, 415, 'application/json; charset=utf-8', JSON.stringify({ error: 'json_required' }));
    let body = '';
    try { for await (const chunk of req) { body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); if (Buffer.byteLength(body, 'utf8') > DELEGATION_BODY_MAX) return send(res, 413, 'application/json; charset=utf-8', JSON.stringify({ error: 'request_too_large' })); } }
    catch { return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' })); }
    let value;
    try { value = JSON.parse(body); } catch { return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_json' })); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'confirmed,operationId,purpose,sessionId' || value.confirmed !== true || typeof value.sessionId !== 'string' || !/^codex_[0-9a-f-]{36}$/i.test(value.sessionId) || !OPERATION_ID.test(value.operationId ?? '') || typeof value.purpose !== 'string' || !value.purpose.trim() || value.purpose.length > 2000) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' }));
    if (demo) return send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'demo_disabled' }));
    if (!startDelegation) return send(res, 501, 'application/json; charset=utf-8', JSON.stringify({ error: 'delegation_unavailable' }));
    try {
      const result = await startDelegation(value.sessionId, value.purpose, true, value.operationId);
      if (result?.ok !== true || result.operationId !== value.operationId || !['running', 'completed', 'failed'].includes(result.status)) return send(res, 422, 'application/json; charset=utf-8', JSON.stringify({ error: ['invalid_target', 'unsupported_location', 'session_active', 'session_unknown', 'already_running', 'operation_limit', 'cli_unavailable'].includes(result?.reason) ? result.reason : 'unavailable' }));
      return send(res, 202, 'application/json; charset=utf-8', JSON.stringify({ operationId: result.operationId, status: result.status }));
    } catch {
      log('term.delegationFailed', {});
      return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'delegation_failed' }));
    }
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} host */
  async function serveWorktreeList(req, res, host) {
    const url = new URL(String(req.url ?? '/'), `http://${host}`);
    const params = [...url.searchParams.entries()];
    const sessionIds = url.searchParams.getAll('sessionId');
    if (params.length !== 1 || sessionIds.length !== 1 || !SESSION_CARD_ID.test(sessionIds[0] ?? '')) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' }));
    if (!listWorktrees) return send(res, 501, 'application/json; charset=utf-8', JSON.stringify({ error: 'worktree_unavailable' }));
    try {
      const result = await listWorktrees(sessionIds[0]);
      if (result?.ok === false) return send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'session_unavailable' }));
      const rows = Array.isArray(result) ? result.slice(0, MAX_WORKTREE_ITEMS) : [];
      const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 999 ? value : 0;
      const items = rows.map((item) => ({
        branch: typeof item?.branch === 'string' && SAFE_BRANCH_RE.test(item.branch) && !item.branch.includes('..') && !item.branch.includes('//') ? item.branch : null,
        status: ['clean', 'changed', 'untracked', 'mixed', 'conflicted', 'unknown'].includes(item?.status) ? item.status : 'unknown',
        changed: count(item?.changed), untracked: count(item?.untracked), conflicted: count(item?.conflicted),
        detached: item?.detached === true, locked: item?.locked === true, prunable: item?.prunable === true, current: item?.current === true,
      }));
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ items }));
    } catch {
      log('term.worktreeFailed', {});
      return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'worktree_failed' }));
    }
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function serveWorktree(req, res) {
    const origin = String(req.headers.origin ?? '');
    if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'origin_rejected' }));
    if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return send(res, 415, 'application/json; charset=utf-8', JSON.stringify({ error: 'json_required' }));
    let body = '';
    try {
      for await (const chunk of req) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (Buffer.byteLength(body, 'utf8') > WORKTREE_BODY_MAX) return send(res, 413, 'application/json; charset=utf-8', JSON.stringify({ error: 'request_too_large' }));
      }
    } catch {
      return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' }));
    }
    let value;
    try { value = JSON.parse(body); } catch { return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_json' })); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['sessionId', 'branch'].includes(key))) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' }));
    if (typeof value.sessionId !== 'string' || !SESSION_CARD_ID.test(value.sessionId) || !isSafeBranch(value.branch)) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' }));
    if (!createWorktree) return send(res, 501, 'application/json; charset=utf-8', JSON.stringify({ error: 'worktree_unavailable' }));
    try {
      const result = await createWorktree(value.sessionId, value.branch);
      if (result?.ok === true && result.branch === value.branch && SAFE_BRANCH_RE.test(result.branch) && !result.branch.includes('..') && !result.branch.includes('//') && ['clean', 'changed', 'untracked', 'mixed', 'conflicted', 'unknown'].includes(result.status)) {
        const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 999 ? value : 0;
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, branch: result.branch, status: result.status, changed: count(result.changed), untracked: count(result.untracked), conflicted: count(result.conflicted) }));
      }
      const reason = ['invalid_target', 'not_repo', 'invalid_branch', 'target_exists', 'creation_failed', 'demo_disabled'].includes(result?.reason) ? result.reason : 'unavailable';
      const status = reason === 'demo_disabled' ? 403 : reason === 'invalid_branch' ? 400 : reason === 'target_exists' ? 409 : 422;
      return send(res, status, 'application/json; charset=utf-8', JSON.stringify({ ok: false, reason }));
    } catch {
      log('term.worktreeFailed', {});
      return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, reason: 'failed' }));
    }
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function serveWorktreeRemoval(req, res) {
    const origin = String(req.headers.origin ?? '');
    if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'origin_rejected' }));
    if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return send(res, 415, 'application/json; charset=utf-8', JSON.stringify({ error: 'json_required' }));
    let body = '';
    try {
      for await (const chunk of req) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (Buffer.byteLength(body, 'utf8') > WORKTREE_BODY_MAX) return send(res, 413, 'application/json; charset=utf-8', JSON.stringify({ error: 'request_too_large' }));
      }
    } catch { return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' })); }
    let value;
    try { value = JSON.parse(body); } catch { return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_json' })); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['sessionId', 'branch', 'confirmed'].includes(key))) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' }));
    if (typeof value.sessionId !== 'string' || !SESSION_CARD_ID.test(value.sessionId) || !isSafeBranch(value.branch) || value.confirmed !== true) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'invalid_request' }));
    if (!removeWorktree) return send(res, 501, 'application/json; charset=utf-8', JSON.stringify({ error: 'worktree_unavailable' }));
    try {
      const result = await removeWorktree(value.sessionId, value.branch, true);
      if (result?.ok === true && result.branch === value.branch && SAFE_BRANCH_RE.test(result.branch) && !result.branch.includes('..') && !result.branch.includes('//')) {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, branch: result.branch }));
      }
      const reason = ['invalid_target', 'not_repo', 'invalid_branch', 'not_found', 'current', 'locked', 'prunable', 'not_clean', 'removal_failed', 'demo_disabled'].includes(result?.reason) ? result.reason : 'unavailable';
      const status = reason === 'demo_disabled' ? 403 : ['invalid_target', 'not_repo'].includes(reason) ? 422 : reason === 'not_found' ? 404 : reason === 'not_clean' || reason === 'current' || reason === 'locked' || reason === 'prunable' ? 409 : 400;
      return send(res, status, 'application/json; charset=utf-8', JSON.stringify({ ok: false, reason }));
    } catch {
      log('term.worktreeFailed', {});
      return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, reason: 'failed' }));
    }
  }

  /** @param {unknown} value */
  function isSafeBranch(value) {
    if (typeof value !== 'string' || !SAFE_BRANCH_RE.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.')) return false;
    return value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.') && !part.toLowerCase().endsWith('.lock'));
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function serveBoard(req, res) {
    try {
      const { body, etag } = await getBoard();
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      send(res, 200, 'application/json; charset=utf-8', body);
    } catch (e) {
      log('term.boardFailed', { name: e instanceof Error ? e.name : 'error' }); // title や本文は書かない
      send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'board_failed' }));
    }
  }
}
