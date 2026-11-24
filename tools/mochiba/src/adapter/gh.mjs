// Calls the GitHub CLI for PR notes. Never throws: a missing or failing gh becomes {ok:false, reason}.
// The JSON gh prints is checked here before it reaches core.
import { execFile as nodeExecFile } from 'node:child_process';

const FIELDS = 'title,body,url,statusCheckRollup';
const TIMEOUT_MS = 30_000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const optionalString = (v) => v == null || typeof v === 'string';

/** True when gh printed the shape core expects. */
export function isPrView(v) {
  return isObject(v) && optionalString(v.title) && optionalString(v.body) && optionalString(v.url)
    && (v.statusCheckRollup == null || (Array.isArray(v.statusCheckRollup) && v.statusCheckRollup.every(isObject)));
}

/** @param {{execFile?: Function}} [deps] execFile is replaceable for tests */
export function createGh({ execFile = nodeExecFile } = {}) {
  return {
    /** @returns {Promise<{ok:true,data:object}|{ok:false,reason:string}>} */
    prView(dir, number) {
      return new Promise((resolve) => {
        execFile('gh', ['pr', 'view', String(number), '--json', FIELDS], { cwd: dir, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
          if (err) { resolve({ ok: false, reason: err.code === 'ENOENT' ? 'gh 無し' : 'gh 失敗' }); return; }
          let data;
          try { data = JSON.parse(stdout); } catch { resolve({ ok: false, reason: 'gh 失敗' }); return; }
          resolve(isPrView(data) ? { ok: true, data } : { ok: false, reason: 'gh 失敗' });
        });
      });
    },
  };
}
