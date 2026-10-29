#!/usr/bin/env node
// Independent local Runtime command. The default `albera` command stays read-only.
import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRuntimeAuditJournal } from './audit-journal.mjs';
import { createRuntimeHost } from './host.mjs';
import { createDesktopWallHost, MAX_WALL_VMS } from './desktop-wall-host.mjs';
import { HyperVDesktopDriver } from './hyperv-desktop-driver.mjs';
import { createHyperVDesktopBrokerPrototype } from './hyperv-desktop-broker-prototype.mjs';
import { createDesktopAgentLoop, MODEL_PRICES } from './desktop-agent-loop.mjs';
import { createAnthropicComputerUseClient, DEFAULT_COMPUTER_USE_MODEL } from './anthropic-computer-use-client.mjs';
import { loadOrCreateRuntimeSessionId } from './session-identity.mjs';
import { backupRuntimeJournal, recoverRuntimeJournalTail, restoreRuntimeJournal, verifyRuntimeJournalBackup } from './journal-backup.mjs';

const WALL_VM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WALL_LABEL_RE = /^[ -~]{1,32}$/;

function parseWallArgs(args) {
  const options = { command: 'wall', vms: [], port: 0, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg !== '--vm' && arg !== '--port') throw new Error('invalid_runtime_option');
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (arg === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('runtime_port_invalid');
      options.port = Number(value);
      continue;
    }
    const separator = value.indexOf(':');
    const vmId = separator < 0 ? value : value.slice(0, separator);
    const label = separator < 0 ? vmId : value.slice(separator + 1);
    if (!WALL_VM_RE.test(vmId) || !WALL_LABEL_RE.test(label)) throw new Error('runtime_wall_vm_invalid');
    if (options.vms.some((vm) => vm.vmId === vmId)) throw new Error('runtime_wall_vm_duplicate');
    options.vms.push(Object.freeze({ vmId, label }));
  }
  if (!options.help && options.vms.length === 0) throw new Error('runtime_wall_vm_required');
  if (options.vms.length > MAX_WALL_VMS) throw new Error('runtime_wall_vm_too_many');
  return Object.freeze({ ...options, vms: Object.freeze(options.vms) });
}

const AGENT_MAX_TASK_LENGTH = 2000;
const AGENT_MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const AGENT_DEFAULTS = Object.freeze({ model: DEFAULT_COMPUTER_USE_MODEL, maxSteps: 40, maxUsd: 0.5, maxMinutes: 15 });
const AGENT_NUMBER_OPTIONS = Object.freeze({ '--max-steps': ['maxSteps', 200, true], '--max-usd': ['maxUsd', 100, false], '--max-minutes': ['maxMinutes', 240, false] });

function parseAgentArgs(args) {
  const options = { command: 'agent', vm: undefined, task: undefined, ...AGENT_DEFAULTS, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--vm', '--task', '--model', ...Object.keys(AGENT_NUMBER_OPTIONS)].includes(arg)) throw new Error('invalid_runtime_option');
    if (seen.has(arg)) throw new Error('runtime_option_must_be_unique');
    seen.add(arg);
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (arg === '--vm') {
      if (!WALL_VM_RE.test(value)) throw new Error('runtime_agent_vm_invalid');
      options.vm = value;
    } else if (arg === '--task') {
      if (value.length > AGENT_MAX_TASK_LENGTH) throw new Error('runtime_agent_task_too_long');
      options.task = value;
    } else if (arg === '--model') {
      if (!AGENT_MODEL_RE.test(value) || !Object.hasOwn(MODEL_PRICES, value)) throw new Error('runtime_agent_model_unknown');
      options.model = value;
    } else {
      const [key, max, integer] = AGENT_NUMBER_OPTIONS[arg];
      const number = Number(value);
      if (!/^\d+(\.\d+)?$/.test(value) || !(number > 0) || number > max || (integer && !Number.isInteger(number))) throw new Error('runtime_agent_limit_invalid');
      options[key] = number;
    }
  }
  if (!options.help && (!options.vm || !options.task)) throw new Error('runtime_agent_vm_and_task_required');
  return Object.freeze(options);
}

export function parseRuntimeArgs(argv, platform = process.platform) {
  const Path = platform === 'win32' ? path.win32 : path;
  if (argv[0] === 'wall') return parseWallArgs(argv.slice(1));
  if (argv[0] === 'agent') return parseAgentArgs(argv.slice(1));
  const command = ['backup', 'restore', 'recover-tail', 'verify-backup'].includes(argv[0]) ? argv[0] : 'serve';
  const args = command === 'serve' ? argv : argv.slice(1);
  if (command !== 'serve') {
    const options = { command, journalPath: undefined, outputPath: undefined, backupPath: undefined, destinationDirectory: undefined, help: false };
    const accepted = command === 'restore' ? ['--backup', '--destination']
      : command === 'verify-backup' ? ['--backup'] : ['--journal', '--output'];
    for (let i = 0; i < args.length; i++) {
      const arg = String(args[i]);
      if (arg === '--help' || arg === '-h') { options.help = true; continue; }
      if (!accepted.includes(arg)) throw new Error('invalid_runtime_option');
      const value = args[++i];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
      if (!Path.isAbsolute(value)) throw new Error('runtime_path_must_be_absolute');
      const key = command === 'verify-backup' ? 'backupPath'
        : command !== 'restore' ? (arg === '--journal' ? 'journalPath' : 'outputPath')
        : (arg === '--backup' ? 'backupPath' : 'destinationDirectory');
      if (options[key]) throw new Error('runtime_option_must_be_unique');
      options[key] = value;
    }
    if (!options.help && (command === 'verify-backup' ? !options.backupPath
      : command === 'restore' ? (!options.backupPath || !options.destinationDirectory)
        : (!options.journalPath || !options.outputPath))) {
      throw new Error('runtime_backup_options_required');
    }
    return Object.freeze(options);
  }
  const options = { roots: [], port: 0, journalPath: undefined, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
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
  albera-runtime backup --journal <absolute-jsonl-path> --output <new-encrypted-backup-path>
  albera-runtime verify-backup --backup <absolute-backup-path>
  albera-runtime restore --backup <absolute-backup-path> --destination <new-private-directory>
  albera-runtime recover-tail --journal <absolute-jsonl-path> --output <new-jsonl-path-in-same-directory>
  albera-runtime wall --vm <hyper-v-vm-name>[:<label>] [--vm ...] [--port <0-65535>]
  albera-runtime agent --vm <hyper-v-vm-name> --task <text> [--model claude-haiku-5-5] [--max-steps 40] [--max-usd 0.50] [--max-minutes 15]

The regular "albera" command remains a read-only session dashboard. Runtime binds only to 127.0.0.1.
Each provider start, input, and stop requires a visible one-use decision in the local approval page.
Only Claude Code is currently profile-configured; installed CLI compatibility is not verified.
The journal stores redacted decisions and lifecycle events, never prompts or process output.
Journal storage permissions are checked without repair; Runtime refuses broad or unverifiable Windows DACLs and POSIX ownership/modes.
Backups are created only while Runtime is stopped. Backup, verification, and restore passphrases are entered in a hidden terminal prompt, never as command-line arguments or environment variables. verify-backup authenticates and validates a backup offline without writing files.
Restore creates a new directory and never overwrites existing files. Keep the passphrase separately; ALBERA cannot recover it.
wall is a local, view-only development command: it shows the latest screen of up to 16 Hyper-V VMs you name, refreshed every 2 seconds, on 127.0.0.1 behind the same one-time code. It never sends input to a VM, keeps only the newest frame in memory and saves nothing. Screens can show secrets; use it only on a PC and display you trust. It uses the same-user prototype Broker and needs Hyper-V Administrators membership.
agent lets an AI operate one Hyper-V VM desktop through screenshots, mouse and keyboard until it says it is done or a limit (steps, USD, minutes) is reached. Ctrl+C stops it before the next action. The Anthropic API key is read only from ANTHROPIC_API_KEY. Screens are sent to the Anthropic API and can show secrets; use only a VM that holds nothing sensitive. The AI saying DONE is a claim, not proof that the task succeeded. It uses the same-user prototype Broker and needs Hyper-V Administrators membership.
recover-tail requires Runtime to be stopped and copies only the fully validated record prefix to a new file beside the original. It keeps the original journal and incomplete tail unchanged, refuses an existing writer lock, and preserves the session identity. It cannot recover a possibly lost final event.
`;

async function readHiddenPassphrase(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('backup_requires_interactive_tty');
  const wasRaw = input.isRaw;
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') { cleanup(); reject(new Error('backup_prompt_cancelled')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); continue; }
        if (char >= ' ' && char !== '\u007f') value += char;
        if (Buffer.byteLength(value, 'utf8') > 1024) { cleanup(); reject(new Error('backup_passphrase_length_invalid')); return; }
      }
    };
    input.on('data', onData);
  });
}

async function runWall(options) {
  let wall;
  try {
    const broker = createHyperVDesktopBrokerPrototype();
    wall = createDesktopWallHost({
      vms: options.vms,
      driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker, resolveCurrentLease }),
    });
    const address = await wall.listen(options.port);
    console.log(`ALBERA desktop wall (view only) listening at ${address.url}`);
    console.log(`One-time UI bootstrap code: ${address.bootstrapCode}`);
    console.log('Open that local URL to watch the VM screens. Press Ctrl+C to stop.');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await wall.close().catch(() => {});
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    await wall?.close().catch(() => {});
    console.error('ALBERA desktop wall could not start. Check the VM names and port.');
    process.exitCode = 1;
  }
}

function formatAgentEvent(event) {
  if (event.type === 'step') return `step ${event.step}: ${event.toolUses} tool call(s), $${event.usd.toFixed(4)}, ${Math.round(event.ms / 1000)}s`;
  if (event.type !== 'action') return null;
  const where = event.cursor ? ` at ${event.cursor[0]},${event.cursor[1]}` : '';
  const length = event.textLength === undefined ? '' : ` (${event.textLength} chars)`;
  return `  ${event.action}${length}${where} ${event.ok ? 'ok' : `failed: ${event.code}`}`;
}

async function runAgent(options) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ALBERA Runtime agent: set the ANTHROPIC_API_KEY environment variable first.'); process.exitCode = 1; return; }
  const started = Date.now();
  const lease = Object.freeze({
    desktopSessionId: `agent-${options.vm}`, ownerType: 'AI', ownerId: 'albera-agent', generation: 1,
    expiresAt: new Date(started + (options.maxMinutes + 1) * 60_000).toISOString(),
  });
  let loop;
  try {
    const broker = createHyperVDesktopBrokerPrototype();
    const driver = new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => lease });
    loop = createDesktopAgentLoop({
      driver,
      client: createAnthropicComputerUseClient({ apiKey, model: options.model }),
      vmId: options.vm, lease, task: options.task,
      limits: { maxSteps: options.maxSteps, maxUsd: options.maxUsd, maxMs: options.maxMinutes * 60_000 },
      prices: MODEL_PRICES[options.model],
      settleMs: 500,
      onEvent: (event) => { const line = formatAgentEvent(event); if (line) console.log(line); },
    });
  } catch {
    console.error('ALBERA Runtime agent could not start. Check the VM name and options.');
    process.exitCode = 1;
    return;
  }
  process.once('SIGINT', () => loop.stop('stopped_by_user'));
  process.once('SIGTERM', () => loop.stop('stopped_by_user'));
  console.log(`ALBERA agent started on ${options.vm} with ${options.model} (limits: ${options.maxSteps} steps, $${options.maxUsd}, ${options.maxMinutes} min). Press Ctrl+C to stop.`);
  const result = await loop.run();
  console.log(`result: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}; ${result.steps} steps, ${result.actions} actions, $${result.usd.toFixed(4)}, ${Math.round(result.ms / 1000)}s`);
  if (result.claim) console.log(`AI said: ${result.claim}`);
  if (result.outcome === 'claimed_done') console.log('Note: this is only what the AI claimed. Check the VM yourself.');
  process.exitCode = result.outcome === 'claimed_done' ? 0 : 1;
}

async function main() {
  let options;
  try { options = parseRuntimeArgs(process.argv.slice(2)); }
  catch (error) { console.error(`ALBERA Runtime: ${error.message}`); process.exitCode = 2; return; }
  if (options.help) { console.log(RUNTIME_HELP); return; }
  if (options.command === 'wall') { await runWall(options); return; }
  if (options.command === 'agent') { await runAgent(options); return; }
  if (options.command === 'backup' || options.command === 'restore' || options.command === 'recover-tail' || options.command === 'verify-backup') {
    try {
      if (options.command === 'backup') {
        const passphrase = await readHiddenPassphrase('Backup passphrase (12+ UTF-8 bytes): ');
        const confirmation = await readHiddenPassphrase('Confirm passphrase: ');
        if (passphrase !== confirmation) throw new Error('backup_passphrase_mismatch');
        const result = await backupRuntimeJournal({ journalPath: options.journalPath, outputPath: options.outputPath, passphrase });
        console.log(`Encrypted Runtime backup created (${result.bytes} bytes).`);
      } else if (options.command === 'verify-backup') {
        const passphrase = await readHiddenPassphrase('Backup passphrase: ');
        const result = await verifyRuntimeJournalBackup({ backupPath: options.backupPath, passphrase });
        console.log(`Encrypted Runtime backup is valid (${result.recordCount} records).`);
      } else if (options.command === 'restore') {
        const passphrase = await readHiddenPassphrase('Backup passphrase: ');
        const result = await restoreRuntimeJournal({ backupPath: options.backupPath, destinationDirectory: options.destinationDirectory, passphrase });
        console.log(`Runtime journal restored to ${result.journalPath}.`);
      } else {
        const result = await recoverRuntimeJournalTail({ journalPath: options.journalPath, outputPath: options.outputPath });
        console.log(`Recovered ${result.recordCount} complete records to ${result.journalPath}; preserved the original and ${result.discardedTailBytes} incomplete tail bytes.`);
      }
    } catch (error) {
      console.error(`ALBERA Runtime ${options.command}: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
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
  } catch (error) {
    await runtime?.close().catch(() => {});
    if (!runtime) await journal?.close().catch(() => {});
    if (error?.code === 'runtime_storage_acl_not_private'
      || ['journal_directory_permissions', 'journal_permissions', 'journal_lock_permissions'].includes(error?.code)
      || ['journal_hard_linked_file', 'journal_lock_hard_linked'].includes(error?.code)
      || error?.code === 'runtime_session_identity_permissions') {
      console.error('ALBERA Runtime could not start because journal storage permissions allow other local principals to access or change its data. Choose a private directory; ALBERA will not change existing permissions.');
      process.exitCode = 1;
      return;
    }
    if (String(error?.code ?? '').startsWith('runtime_storage_acl_')) {
      console.error('ALBERA Runtime could not verify journal storage permissions and stopped without changing existing data.');
      process.exitCode = 1;
      return;
    }
    console.error('ALBERA Runtime could not start. Check the selected root, journal, and port.');
    process.exitCode = 1;
  }
}

function isMainModule(moduleUrl, argvPath) {
  if (typeof argvPath !== 'string' || argvPath.length === 0) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath); }
  catch { return false; }
}

if (isMainModule(import.meta.url, process.argv[1])) void main();
