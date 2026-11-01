import { spawn } from 'node:child_process';
import path from 'node:path';

// How the host runs git, shared by git-quarantine.mjs and git-promotion.mjs (ADR-007). argv only, no shell, a fixed environment without the
// user's global or system config, the hardening flags below on every call, a deadline and an output cap. Output is never logged.

export const TIMEOUT_MS = 60_000;
export const MAX_OUTPUT = 32 * 1024 * 1024;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export const isOid = (v) => typeof v === 'string' && OID_RE.test(v);

// Hardening on every call: no hooks (and `init --template=` copies no sample hooks), no fsmonitor, no transport but `file` (git reads a bundle through it;
// importBundle only passes a path that lstat shows is a regular file, so a repository folder is never fetched from), objects fsck'd
// on the way in, no automatic gc or maintenance, no replace refs, no credential helper, no pager.
export const hardening = (root) => [
  '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'transfer.fsckObjects=true',
  '-c', 'fetch.fsckObjects=true', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.useReplaceRefs=false',
  '-c', 'credential.helper=', '-c', 'core.pager=cat', '-c', 'advice.detachedHead=false',
];   // core.hooksPath names a folder that is never created, so no hook can exist

// A fixed environment: the system and global config files are not read (a host user's aliases, credential helpers or hooks must not apply), no
// prompts, no editor, no pager, English messages. Only PATH-free essentials are kept (SYSTEMROOT is needed by Windows for sockets and crypto).
export function gitEnv(root) {
  const env = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '',
    GIT_EDITOR: ':', GIT_PAGER: 'cat', LC_ALL: 'C', LANG: 'C', HOME: root, GIT_OPTIONAL_LOCKS: '0',
  };
  for (const key of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

// argv only (shell: false), a fixed environment, a deadline and an output cap; stdout and stderr are collected as UTF-8 and never logged.
// A timeout, a spawn failure or the output cap gives code -1 with `failure` set, so a caller can tell "git said no" from "no answer".
export function runGitProcess(file, args, { env, input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = []; let size = 0; let failed = null;
    const stop = (why) => { if (!failed) { failed = why; child.kill(); } };
    const timer = setTimeout(() => stop('timeout'), TIMEOUT_MS);
    const take = (chunks) => (chunk) => { size += chunk.length; if (size > MAX_OUTPUT) stop('output_limit'); else chunks.push(chunk); };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    child.on('error', () => stop('spawn_failed'));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const code = failed ? -1 : exitCode ?? -1;
      if (code !== 0 && !allowFailure) return reject(Object.assign(new Error('git_failed'), { code: 'git_failed', exitCode: code }));
      resolve({ code, failure: failed, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
