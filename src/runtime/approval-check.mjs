import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createApprovedOperationFlow } from './approved-operation-flow.mjs';
import { REAL_APPROVAL_DEPS, authorityPort, brokerPort, loadApprovalSettings } from './room-approval-wiring.mjs';

// `albera-runtime approval-check --approval <albera.approval.json> [--helper <absolute path>]`: the first harmless request after the host install.
// It is wiring only (entry role): the same settings file, real pipe clients and durable flow journal as the gated room, one operation through
// createApprovedOperationFlow (fence -> submit -> wait for a person -> claim), and a printout. The operation is `broker.operation` / `synthetic.noop`: the Broker
// only records the claim and does nothing else, so approving it moves nothing and starts nothing. No decision is made here and nothing is retried beyond the flow's own rules.
// Run it as the Control Plane account (the only account the Broker and Authority submit pipes admit); the approver console runs as the person.
// The pipe client helper defaults to the build output next to the sources; --helper names another copy (its `.manifest.json` must sit beside it).
// Errors are fixed codes (`runtime_approval_check_*`, and the settings loader's `runtime_room_approval_*`); the file's content and paths are never printed.

export const CHECK_PURPOSE = 'broker.operation';
export const CHECK_ACTION = 'synthetic.noop';
const fail = (what) => new Error(`runtime_approval_check_${what}`);
const CLIENT_NAMES = ['sendBrokerFence', 'sendBrokerRequest', 'sendBrokerInspect', 'submitApproval', 'getApprovalStatus'];

/** Parse the command's arguments. Pure. @returns {Readonly<{ command: 'approval-check', approvalFile: string|null, helperPath: string|null, help: boolean }>} */
export function parseApprovalCheckArgs(args) {
  const options = { command: 'approval-check', approvalFile: null, helperPath: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg !== '--approval' && arg !== '--helper') throw new Error('invalid_runtime_option');
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    const key = arg === '--approval' ? 'approvalFile' : 'helperPath';
    if (options[key] !== null) throw new Error('runtime_option_must_be_unique');
    if (key === 'helperPath' && !path.isAbsolute(value)) throw fail('helper_must_be_absolute');
    options[key] = value;
  }
  if (!options.help && options.approvalFile === null) throw fail('needs_approval');
  return Object.freeze(options);
}

/** The five real clients, each told which helper copy to start. */
function withHelper(deps, helperPath) {
  const bound = { ...deps };
  for (const name of CLIENT_NAMES) bound[name] = (options) => deps[name]({ ...options, helperPath });
  return bound;
}

/** The authority port, with `onSubmitted` called for each approval id the Authority hands back (so the person can be told while the flow waits). */
function announcingAuthority(port, onSubmitted) {
  return {
    ...port,
    async submit(fields) {
      const reply = await port.submit(fields);
      if (reply?.ok === true && typeof reply.approvalId === 'string') onSubmitted(reply);
      return reply;
    },
  };
}

const defaultOperationId = () => `check-${randomBytes(6).toString('hex')}`;

/**
 * Run one synthetic.noop operation through the approval flow.
 * @param {{ approvalFile: string, helperPath?: string|null }} options
 * @param {{ io?: object, deps?: object, out?: (line: string) => void }} [env] `io` = the settings loader's file access; `deps` replaces the real clients, store, clock and ids (tests)
 * @returns {Promise<{ exitCode: number, result: object }>} exit 0 only when the Broker claimed the operation
 */
export async function runApprovalCheck({ approvalFile, helperPath = null }, { io, deps = {}, out = console.log } = {}) {
  const settings = loadApprovalSettings(approvalFile, io);
  const d = { ...REAL_APPROVAL_DEPS, newCheckOperationId: defaultOperationId, ...deps };
  const clients = helperPath ? withHelper(d, helperPath) : d;
  const computerId = [...settings.computers.values()][0].computerId;
  let store;
  try { store = await d.openStore(settings.journal); } catch { throw fail('journal_unavailable'); }
  try {
    let announced = null;
    const authority = announcingAuthority(authorityPort(settings, clients), (reply) => {
      if (reply.approvalId === announced) return;
      announced = reply.approvalId;
      out(`approvalId: ${reply.approvalId}`);
      if (reply.state === 'approved') out('The Authority approved it without a person (policy); claiming now.');
      else {
        out('Waiting for a person (the request lasts about 2 minutes). In your own console, as the account that enrolled Windows Hello, not elevated:');
        out('  AlberaApprover.exe list                       (check every field and "digest check: OK")'); // arch-allow: the one place that tells the person which console program approves
        out(`  AlberaApprover.exe approve ${reply.approvalId}   (type yes, then verify with Windows Hello)`); // arch-allow: same message
      }
    });
    const flow = createApprovedOperationFlow({ broker: brokerPort(settings, clients, null), authority, journal: store.flowJournal(), now: d.now, sleep: d.sleep });
    out(`approval-check: one ${CHECK_ACTION} operation for computer ${computerId} in project ${settings.projectId}. It changes nothing: the Broker only records the claim.`);
    const result = await flow.run({ operationId: d.newCheckOperationId(), purpose: CHECK_PURPOSE, action: { action: CHECK_ACTION, projectId: settings.projectId, computerId, args: {} } });
    const detail = [result.code ? `code ${result.code}` : null, result.brokerState ? `Broker state ${result.brokerState}` : null, result.replayed ? 'replayed' : null].filter(Boolean).join(', ');
    out(`status: ${result.status}${detail ? ` (${detail})` : ''}`);
    return { exitCode: result.status === 'claimed' ? 0 : 1, result };
  } finally {
    try { store.close(); } catch { /* already closed */ }
  }
}

/** The command as `albera-runtime` runs it: prints, sets the exit code, never prints a path or a file's content. */
export async function runApprovalCheckCommand(options, env = {}) {
  try {
    const { exitCode } = await runApprovalCheck(options, env);
    process.exitCode = exitCode;
  } catch (error) {
    const code = typeof error?.message === 'string' && /^runtime_[a-z_]+$/u.test(error.message) ? error.message : 'runtime_approval_check_failed';
    console.error(`ALBERA Runtime approval-check: ${code}`);
    process.exitCode = 2;
  }
}
