import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { guestText, SHELL_HANDS } from './albera-shell-mcp-server.mjs';
import { buildShellMcpFlags } from './albera-shell-mcp-args.mjs';

// One WSL2 job around the driver (ADR-012, decisions 9 and 10; Proposed / NOT VERIFIED on a real run). The model's tools act in a run that exists; only this file begins and ends that run, so the lease
// never reaches the model. Order: the lease, `begin`, the driver, the result bundle, `end`, then the quarantine. Every way out that is not a clean `end` calls `stop`, so no distribution is left behind.
//
// The lease comes from `leases.obtain`. The production Broker has no key to sign one (ADR-002 AGM-2), so the service passes NO_LEASE_SOURCE and every job stops here with `wsl2_lease_unavailable`.
// The result is what the job handed over, never verified: `trust` is always `agent_reported`, and its text is cleaned here and escaped by the page. It is a bundle, so nothing of the job runs on this side.
// The code words are fixed. A word from the bridge goes to the log only after it has passed WORD_RE.

export const NO_LEASE_SOURCE = Object.freeze({ obtain: async () => null });
export const MAX_RESULT_BYTES = 64 * 1024 * 1024;
export const KEPT_RESULTS = 5;
export const READY_REFRESH_MS = 30_000;
const WORD_RE = /^[a-z0-9_]{1,48}$/u;
const HALT_FILE = 'halt';
const BUNDLE_HEAD_SCAN_BYTES = 64 * 1024;
const HEAD_LINE_RE = /^([0-9a-f]{40}|[0-9a-f]{64}) HEAD$/u;
const wordOf = (error) => (typeof error?.code === 'string' && WORD_RE.test(error.code) ? error.code : 'unknown');
const over = (reason) => Object.freeze({ outcome: 'error', reason, claim: '', toolCalls: 0 });
const stoppedByHuman = () => Object.freeze({ outcome: 'stopped', reason: 'stopped_by_human', claim: '', toolCalls: 0 });

/** The commit `HEAD` names in a bundle's header, or null. Only the header is read, and only as text; git checks the rest in the quarantine. */
export function headOfBundle(bundle) {
  const end = bundle.indexOf('\n\n', 0, 'latin1');
  if (end < 0 || end > BUNDLE_HEAD_SCAN_BYTES) return null;
  const lines = bundle.subarray(0, end).toString('latin1').split('\n');
  if (lines[0] !== '# v2 git bundle' && lines[0] !== '# v3 git bundle') return null;
  for (const line of lines.slice(1)) {
    const found = line.match(HEAD_LINE_RE);
    if (found) return found[1];
  }
  return null;
}

/** Keep the newest KEPT_RESULTS bundles. Only names this file writes. */
async function pruneResults(resultsRoot, note) {
  try {
    const names = (await readdir(resultsRoot)).filter((name) => name.endsWith('.bundle'));
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(resultsRoot, name))).mtimeMs })));
    for (const { name } of dated.sort((a, b) => b.at - a.at).slice(KEPT_RESULTS)) await rm(path.join(resultsRoot, name), { force: true });
  } catch { note('hands wsl2_result_prune_failed'); }
}

/**
 * From the bundle's bytes to what the room shows. `{ ok: false, code }` for anything the quarantine refuses, and the room says so: a refused result is not shown as a diff.
 * The quarantine's repository goes when this is done; the bundle stays in `resultsRoot` for the owner, the newest KEPT_RESULTS of them.
 */
export async function collectWsl2Result({ bundle, baseOid, operationId, quarantine, runDir, resultsRoot, note = () => {} }) {
  const refused = (code) => Object.freeze({ ok: false, trust: 'agent_reported', operationId, baseOid, code });
  if (bundle.length === 0 || bundle.length > MAX_RESULT_BYTES) return refused('result_too_large');
  const resultOid = headOfBundle(bundle);
  if (resultOid === null) return refused('bundle_invalid');
  const bundlePath = path.join(runDir, 'result.bundle');
  let repo = null;
  try {
    await writeFile(bundlePath, bundle, { flag: 'wx' });
    repo = await quarantine.create();
    const imported = await quarantine.importBundle(repo, { bundlePath, ref: 'HEAD', expectedOid: resultOid });
    if (!imported.ok) return refused(imported.code);
    const inspected = await quarantine.inspect(repo, { baseOid, resultOid });
    if (!inspected.ok) return refused(inspected.code);
    const shown = await quarantine.diff(repo, { baseOid, resultOid });
    if (!shown.ok) return refused(shown.code);
    await mkdir(resultsRoot, { recursive: true });
    await writeFile(path.join(resultsRoot, `${operationId}.bundle`), bundle);
    await pruneResults(resultsRoot, note);
    return Object.freeze({
      ok: true, trust: 'agent_reported', operationId, baseOid, resultOid, commits: inspected.commits, truncated: shown.truncated, diff: guestText(Buffer.from(shown.text, 'utf8')),
      files: Object.freeze(shown.files.map(({ status, path: file }) => Object.freeze({ status, path: guestText(Buffer.from(file, 'utf8')) }))),
    });
  } catch { return refused('result_failed'); } finally {
    if (repo !== null) await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => note('hands wsl2_quarantine_cleanup_failed'));
  }
}

async function readHaltWord(file) {
  try {
    const word = (await readFile(file, 'utf8')).trim();
    return WORD_RE.test(word) ? word : 'unknown';
  } catch { return null; } // no file: the server never halted
}

/**
 * @param {{ wsl2: { client: object, leases: { obtain: Function }, quarantine: object, shell: { command: string, entryPath: string, bridge: object }, resultsRoot: string },
 *   job: { operationId: string, computerId: string, repositoryId: string, baseOid: string }, run: { stopRequested: boolean, stopBridge?: Function }, runDir: string,
 *   runDriver: (options: { mcpServer: object, hands: object }) => Promise<object>, note: (line: string) => void }} options
 * @returns {Promise<{ result: object, collected: object|null }>} `result` in the driver's shape, `collected` what the room shows, or null when the run gave nothing to show.
 */
export async function runWsl2Job({ wsl2, job, run, runDir, runDriver, note }) {
  const { client, leases, quarantine, shell, resultsRoot } = wsl2;
  const { operationId, baseOid } = job;
  let lease = null;
  try { lease = await leases.obtain(job); } catch { note('hands wsl2_lease_failed'); }
  if (lease === null || lease === undefined) return { result: over('wsl2_lease_unavailable'), collected: null };

  let open = true; // the bridge may hold a run: from before `begin` is sent, because an unknown answer may have made one
  const stopBridge = async () => {
    if (!open) return;
    try { await client.stop(operationId); open = false; } catch (error) { if (error?.code === 'no_run') open = false; else note(`hands wsl2_stop_failed ${wordOf(error)}`); }
  };
  run.stopBridge = stopBridge;
  try {
    try { await client.begin(operationId, lease); } catch (error) {
      if (error?.outcome !== 'unknown') open = false;
      note(`hands wsl2_begin_refused ${wordOf(error)}`);
      return { result: run.stopRequested ? stoppedByHuman() : over('wsl2_begin_failed'), collected: null };
    }
    if (run.stopRequested) return { result: stoppedByHuman(), collected: null };

    const haltFile = path.join(runDir, HALT_FILE);
    const args = buildShellMcpFlags({ entryPath: shell.entryPath, operationId, bridge: shell.bridge, haltFile });
    const result = await runDriver({ mcpServer: { command: shell.command, args }, hands: SHELL_HANDS });
    const halted = await readHaltWord(haltFile); // the model was told in words; this is the record of why, a squatted pipe above all
    if (halted !== null) note(`hands wsl2_shell_halted ${halted}`);
    if (run.stopRequested || result.outcome === 'stopped') return { result, collected: null };

    let bundle = null;
    let failure = null;
    try { bundle = await client.bundle(operationId); } catch (error) { failure = wordOf(error); note(`hands wsl2_bundle_failed ${failure}`); }
    try { await client.end(operationId); open = false; } catch (error) {
      if (error?.code === 'no_run') { open = false; failure = 'run_ended_early'; } else failure ??= 'end_failed'; // the bridge ended it first: what was to be collected is not to be trusted to be whole
      note(`hands wsl2_end_failed ${wordOf(error)}`);
    }
    if (failure !== null) return { result, collected: Object.freeze({ ok: false, trust: 'agent_reported', operationId, baseOid, code: failure === 'run_ended_early' ? failure : 'result_missing' }) };
    return { result, collected: await collectWsl2Result({ bundle, baseOid, operationId, quarantine, runDir, resultsRoot, note }) };
  } finally {
    await stopBridge();
    run.stopBridge = undefined;
  }
}

/**
 * Decision 14: the level exists only while the bridge answers and its kernel is above the floor. `ready()` answers from the last `status` and asks again in the background at most every REFRESH_MS,
 * so a page that polls starts no process per poll. Before the first answer, and after any failure, it says no.
 */
export function createWsl2Readiness({ client, note = () => {}, now = Date.now }) {
  let ok = false;
  let askedAt = -Infinity;
  let asking = false;
  async function ask() {
    asking = true;
    try { ok = (await client.status()).kernelOk === true; } catch (error) { ok = false; note(`hands wsl2_status_failed ${wordOf(error)}`); } finally { asking = false; }
  }
  return Object.freeze({
    ready() {
      if (!asking && now() - askedAt >= READY_REFRESH_MS) { askedAt = now(); void ask(); }
      return ok;
    },
  });
}

/** What the owner approves as `baseOid`: the head the bridge reads, because the Control Plane's account may not be able to read the repository (ADR-012, decision 4). */
export function wsl2TargetLookup({ client, repositoryOf }) {
  return async (computerId) => {
    const repositoryId = repositoryOf(computerId);
    if (repositoryId === undefined) return undefined;
    const { head } = await client.status({ repositoryId });
    return { repositoryId, baseOid: head };
  };
}
