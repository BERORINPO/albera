#!/usr/bin/env node
// Independent local Runtime command. The default `albera` command stays read-only.
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { openRuntimeAuditJournal } from './audit-journal.mjs';
import { createRuntimeHost } from './host.mjs';
import { loadOrCreateRuntimeSessionId } from './session-identity.mjs';

const P = process.platform === 'win32' ? path.win32 : path;

export function parseRuntimeArgs(argv, platform = process.platform) {
  const Path = platform === 'win32' ? path.win32 : path;
  const options = { roots: [], port: 0, journalPath: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--root', '--port', '--journal'].includes(arg)) throw new Error('invalid_runtime_option');
    const value = argv[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (arg === '--root') {
      if (!Path.isAbsolute(value)) throw new Error('runtime_root_must_be_absolute');
      options.roots.push(value);
    } else if (arg === '--journal') {
      if (!Path.isAbsolute(value) || options.journalPath) throw new Error('runtime_journal_must_be_absolute_and_unique');
      options.journalPath = value;
    } else {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('runtime_port_invalid');
      options.port = Number(value);
    }
  }
  if (options.help) return Object.freeze({ ...options, roots: Object.freeze(options.roots) });
  if (options.roots.length === 0 || !options.journalPath) throw new Error('runtime_root_and_journal_required');
  return Object.freeze({ ...options, roots: Object.freeze([...new Set(options.roots)]) });
}

export const RUNTIME_HELP = `ALBERA Runtime — separate local execution and approval host

Usage:
  albera-runtime --root <absolute-project-directory> [--root <directory> ...] --journal <absolute-jsonl-path> [--port <0-65535>]

The regular "albera" command remains a read-only session dashboard. Runtime binds only to 127.0.0.1.
Each provider start, input, and stop requires a visible one-use decision in the local approval page.
Only Claude Code is currently profile-configured; installed CLI compatibility is not verified.
The journal stores redacted decisions and lifecycle events, never prompts or process output.
`;

async function main() {
  let options;
  try { options = parseRuntimeArgs(process.argv.slice(2)); }
  catch (error) { console.error(`ALBERA Runtime: ${error.message}`); process.exitCode = 2; return; }
  if (options.help) { console.log(RUNTIME_HELP); return; }
  let journal;
  let runtime;
  try {
    journal = await openRuntimeAuditJournal(options.journalPath);
    const sessionId = await loadOrCreateRuntimeSessionId(options.journalPath);
    runtime = createRuntimeHost({ roots: options.roots, journal, hostOptions: { sessionId } });
    const address = await runtime.listen(options.port);
    console.log(`ALBERA Runtime listening at ${address.url}`);
    console.log(`One-time UI bootstrap code: ${address.bootstrapCode}`);
    console.log('Open that local URL to review and control Runtime actions. Press Ctrl+C to stop.');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const uncertain = await runtime.close().catch(() => ['unknown']);
      if (uncertain.length) {
        console.error(`ALBERA Runtime: cleanup could not be confirmed for ${uncertain.length} run(s).`);
        process.exitCode = 1;
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    await runtime?.close().catch(() => {});
    if (!runtime) await journal?.close().catch(() => {});
    console.error('ALBERA Runtime could not start. Check the selected root, journal, and port.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(P.resolve(process.argv[1])).href) void main();
