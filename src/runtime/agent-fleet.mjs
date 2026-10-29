import { createDesktopAgentLoop } from './desktop-agent-loop.mjs';
import { createAgentStatusBoard } from './agent-status-board.mjs';

export const MAX_FLEET_JOBS = 8;
const LEASE_SLACK_MS = 60_000;

/**
 * Runs one desktop agent loop per VM at the same time. Each VM gets its own AI lease
 * (ownerId `albera-agent-<vm>`), its own driver and its own client. When the SUM of the reported
 * costs reaches `totalMaxUsd`, every loop is stopped. Because loops run at once, each may finish the
 * response it already paid for, so the total can pass the limit by about one step per VM.
 * `createDriver(vmId, lease)` and `createClient(vmId)` are injected: this module touches no VM and no network.
 * @param {{jobs: {vmId: string, task: string}[], createDriver: Function, createClient: Function, limits: object, prices: object, totalMaxUsd: number, board?: object, now?: () => number, settleMs?: number, onEvent?: (vmId: string, event: object) => void}} options
 */
export function createAgentFleet({
  jobs, createDriver, createClient, limits, prices, totalMaxUsd, board = createAgentStatusBoard(),
  now = Date.now, settleMs = 0, onEvent = () => {},
} = {}) {
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > MAX_FLEET_JOBS) throw new TypeError('invalid_fleet_jobs');
  if (new Set(jobs.map((job) => job?.vmId)).size !== jobs.length) throw new TypeError('invalid_fleet_jobs');
  if (typeof totalMaxUsd !== 'number' || !Number.isFinite(totalMaxUsd) || totalMaxUsd <= 0) throw new TypeError('invalid_fleet_total_limit');
  const spent = new Map();
  let stopReason = null;
  const loops = new Map();

  function stop(reason = 'stopped') {
    if (stopReason === null) stopReason = String(reason).slice(0, 80);
    for (const loop of loops.values()) loop.stop(stopReason);
  }
  const total = () => [...spent.values()].reduce((sum, usd) => sum + usd, 0);

  function handle(vmId, event) {
    board.record(vmId, event);
    if ((event.type === 'step' || event.type === 'end') && Number.isFinite(event.usd)) spent.set(vmId, event.usd);
    if (stopReason === null && total() >= totalMaxUsd) stop('max_usd_total');
    onEvent(vmId, event);
  }

  const started = now();
  for (const { vmId, task } of jobs) {
    const lease = Object.freeze({
      desktopSessionId: `agent-${vmId}`, ownerType: 'AI', ownerId: `albera-agent-${vmId}`, generation: 1,
      expiresAt: new Date(started + limits.maxMs + LEASE_SLACK_MS).toISOString(),
    });
    loops.set(vmId, createDesktopAgentLoop({
      driver: createDriver(vmId, lease), client: createClient(vmId), vmId, lease, task, limits, prices, now, settleMs,
      onEvent: (event) => handle(vmId, event),
    }));
  }

  async function run() {
    const entries = [...loops];
    const settled = await Promise.all(entries.map(async ([vmId, loop]) => {
      try { return await loop.run(); }
      catch { return Object.freeze({ outcome: 'error', claim: '', reason: 'agent_error', steps: 0, actions: 0, usd: spent.get(vmId) ?? 0, ms: 0 }); }
    }));
    const results = Object.fromEntries(entries.map(([vmId], i) => [vmId, settled[i]]));
    return Object.freeze({ results, totalUsd: Math.round(total() * 1e6) / 1e6, stopReason });
  }

  return Object.freeze({ run, stop, board });
}
