// @ts-check
// entry: HTTP の受け口。横断的なヘッダーは全レスポンスに一括で付ける。spec/board.md §12
// Host 検査 (DNS rebinding 対策) → GET 以外は 405 → 起動時に作った配信表にあるパスだけ返す (パスの結合はしない)。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELLO_PATH, helloBody } from './probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = 'text/javascript; charset=utf-8';

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
 * @param {{port: number, getBoard: () => Promise<{body: string, etag: string}>, demo?: boolean,
 *   log?: (key: string, params?: Record<string, unknown>) => void, staticFiles?: StaticTable}} deps
 *   log は messages.mjs のキーで受ける (言葉は server が付ける)。demo は /api/hello で答える (ポートが使用中のときの確かめ用)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler({ port, getBoard, demo = false, log = () => {}, staticFiles = buildStaticFiles() }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
    }
    const pathname = String(req.url ?? '/').split('?')[0];
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
