// @ts-check
// entry: ポートが使用中のとき、そこで応答しているのがこのボードらしいか、デモか実データかを確かめる。
// 127.0.0.1 の自分のポートにだけ GET /api/hello する (外部への通信はしない)。
// 応答は真似できるので「このボードらしい」までしか言えない。端末の案内は、自分で起動していなければ別の番号で、と添える。

import http from 'node:http';
import { PRODUCT } from '../shared/constants.mjs';

const PROBE_TIMEOUT_MS = 1500;
const PROBE_BODY_MAX = 4 * 1024;
export const HELLO_PATH = '/api/hello';

/** @typedef {'live'|'demo'} BoardMode */

/**
 * /api/hello の本文。
 * @param {boolean} demo
 */
export const helloBody = (demo) => JSON.stringify({ app: PRODUCT.bin, demo });

/**
 * /api/hello の本文を読む (純粋)。このボードの形でなければ null。
 * @param {string} body
 * @returns {BoardMode|null}
 */
export function parseHello(body) {
  try {
    const v = JSON.parse(body);
    if (!v || typeof v !== 'object' || v.app !== PRODUCT.bin || typeof v.demo !== 'boolean') return null;
    return v.demo ? 'demo' : 'live';
  } catch {
    return null;
  }
}

/**
 * @param {number} port
 * @returns {Promise<BoardMode|null>} このボードらしい応答ならその種類 (live = 実データ / demo)。別のアプリ・無応答・エラーは null
 */
export function probeBoard(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: HELLO_PATH, headers: { Host: `127.0.0.1:${port}` }, timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
          if (body.length > PROBE_BODY_MAX) req.destroy();
        });
        res.on('end', () => resolve(res.statusCode === 200 ? parseHello(body) : null));
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.on('close', () => resolve(null));
  });
}
