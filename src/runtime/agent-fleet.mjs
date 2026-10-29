import { createDesktopAgentLoop } from './desktop-agent-loop.mjs';
import { createPlannedAgentLoop } from './planned-agent-loop.mjs';
import { createAgentStatusBoard } from './agent-status-board.mjs';

export const MAX_FLEET_JOBS = 8;
const LEASE_SLACK_MS = 60_000;
const VM_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Runs one desktop agent loop per VM at the same time. Each VM gets its own AI lease
 * (ownerId `albera-agent-<vm>`), its own driver and its own client. When the SUM of the reported
 * costs reaches `totalMaxUsd`, every loop is stopped. Because loops run at once, each may finish the
 * response it already paid for, so the total can pass the limit by about one step per VM.
 * `createDriver(vmId, lease)` and `createClient(vmId, task)` are injected: this module touches no VM and no network.
 *
 * Room mode (`keepAlive: true`): `jobs` may be empty, `vmIds` names the other VMs `startJob` may use, and
 * `run()` resolves only after `close()`. A VM runs at most one loop at a time. All jobs on a VM share that VM's
 * `limits.maxUsd`, and every job counts toward `totalMaxUsd`; a job is refused when no budget is left.
 * Each job gets a fresh lease (generation = job number on that VM). `onEvent` also receives
 * `{type: 'start', job, task}` when a job starts, so a watcher can record which task the hands were given.
 *
 * Planner (`planner: {createClient, prices}`): every job runs as a planned loop (planned-agent-loop.mjs): a stronger
 * model splits the task into sub-goals for the hands. Its calls count toward the same per-VM and total USD limits.
 * @param {{jobs: {vmId: string, task: string}[], createDriver: Function, createClient: Function, limits: object, prices: object, totalMaxUsd: number, board?: object, now?: () => number, settleMs?: number, onEvent?: (vmId: string, event: object) => void, keepAlive?: boolean, vmIds?: string[], planner?: {createClient: Function, prices: object} | null}} options
 */
export function createAgentFleet({
  jobs, createDriver, createClient, limits, prices, totalMaxUsd, board = createAgentStatusBoard(),
  now = Date.now, settleMs = 0, onEvent = () => {}, keepAlive = false, vmIds = [], planner = null,
} = {}) {
  if (planner !== null && (typeof planner?.createClient !== 'function' || !planner.prices)) throw new TypeError('invalid_fleet_planner');
  if (!Array.isArray(jobs) || jobs.length < (keepAlive ? 0 : 1) || jobs.length > MAX_FLEET_JOBS) throw new TypeError('invalid_fleet_jobs');
  if (new Set(jobs.map((job) => job?.vmId)).size !== jobs.length) throw new TypeError('invalid_fleet_jobs');
  if (typeof totalMaxUsd !== 'number' || !Number.isFinite(totalMaxUsd) || totalMaxUsd <= 0) throw new TypeError('invalid_fleet_total_limit');
  if (!Array.isArray(vmIds) || !vmIds.every((id) => typeof id === 'string' && VM_RE.test(id))) throw new TypeError('invalid_fleet_vms');
  const known = new Set([...jobs.map((job) => job.vmId), ...vmIds]);
  if (known.size > MAX_FLEET_JOBS || known.size < 1) throw new TypeError('invalid_fleet_jobs');

  // Per VM: usd of finished jobs, usd of the running job, the loop (prepared or running) and the last result.
  const vms = new Map([...known].map((vmId) => [vmId, { doneUsd: 0, runUsd: 0, loop: null, task: '', running: null, jobs: 0, result: null }]));
  let stopReason = null;
  let closed = false;
  let started = false;
  let releaseClose;
  const closedPromise = new Promise((resolve) => { releaseClose = resolve; });

  const spentOn = (vm) => vm.doneUsd + vm.runUsd;
  const total = () => [...vms.values()].reduce((sum, vm) => sum + spentOn(vm), 0);
  const refuse = (code) => Object.freeze({ ok: false, code });

  function stop(reason = 'stopped') {
    if (stopReason === null) stopReason = String(reason).slice(0, 80);
    for (const vm of vms.values()) vm.loop?.stop(stopReason);
  }

  function handle(vmId, event) {
    board.record(vmId, event);
    const vm = vms.get(vmId);
    if ((event.type === 'step' || event.type === 'end') && Number.isFinite(event.usd)) vm.runUsd = event.usd;
    if (stopReason === null && total() >= totalMaxUsd) stop('max_usd_total');
    onEvent(vmId, event);
  }

  /** Make the loop for one job (its driver and client are made here). */
  function prepare(vmId, task, maxUsd) {
    const vm = vms.get(vmId);
    const generation = vm.jobs + 1;
    const lease = Object.freeze({
      desktopSessionId: `agent-${vmId}`, ownerType: 'AI', ownerId: `albera-agent-${vmId}`, generation,
      expiresAt: new Date(now() + limits.maxMs + LEASE_SLACK_MS).toISOString(),
    });
    const options = {
      driver: createDriver(vmId, lease), client: createClient(vmId, task), vmId, lease, task,
      limits: { ...limits, maxUsd }, prices, now, settleMs,
      onEvent: (event) => handle(vmId, event),
    };
    const loop = planner
      ? createPlannedAgentLoop({ ...options, plannerClient: planner.createClient(vmId, task), plannerPrices: planner.prices })
      : createDesktopAgentLoop(options);
    vm.jobs = generation;
    vm.runUsd = 0;
    vm.loop = loop;
    vm.task = task;
  }

  function launch(vmId) {
    const vm = vms.get(vmId);
    const { loop } = vm;
    try { onEvent(vmId, Object.freeze({ type: 'start', job: vm.jobs, task: vm.task })); } catch { /* a listener must not break the fleet */ }
    vm.running = (async () => {
      let result;
      try { result = await loop.run(); }
      catch { result = Object.freeze({ outcome: 'error', claim: '', reason: 'agent_error', steps: 0, actions: 0, usd: vm.runUsd, ms: 0 }); }
      vm.doneUsd += Math.max(Number.isFinite(result.usd) ? result.usd : 0, vm.runUsd);
      vm.runUsd = 0;
      vm.loop = null;
      vm.running = null;
      vm.result = result;
      return result;
    })();
    return vm.running;
  }

  for (const { vmId, task } of jobs) prepare(vmId, task, limits.maxUsd);

  async function run() {
    if (started) throw new Error('fleet_already_running');
    started = true;
    const first = [...vms].filter(([, vm]) => vm.loop).map(([vmId]) => launch(vmId));
    await Promise.all(first);
    if (keepAlive) {
      await closedPromise;
      await Promise.all([...vms.values()].map((vm) => vm.running));
    }
    const results = Object.fromEntries([...vms].filter(([, vm]) => vm.result).map(([vmId, vm]) => [vmId, vm.result]));
    return Object.freeze({ results, totalUsd: Math.round(total() * 1e6) / 1e6, stopReason });
  }

  /** Start a new job on an idle VM. The task text comes from the caller (the room host builds it). */
  function startJob(vmId, task) {
    const vm = typeof vmId === 'string' ? vms.get(vmId) : undefined;
    if (!vm) return refuse('vm_unknown');
    if (closed || stopReason !== null || typeof task !== 'string' || task.length < 1) {
      return refuse(stopReason === 'max_usd_total' ? 'over_budget' : 'fleet_stopped');
    }
    if (vm.loop) return refuse('vm_busy');
    const left = limits.maxUsd - spentOn(vm);
    if (left <= 0 || total() >= totalMaxUsd) return refuse('over_budget');
    try { prepare(vmId, task, left); } catch { return refuse('fleet_stopped'); }
    if (started) void launch(vmId);
    return Object.freeze({ ok: true });
  }

  /** Stop the loop on one VM. Returns true when a loop was there. */
  function stopVm(vmId) {
    const vm = typeof vmId === 'string' ? vms.get(vmId) : undefined;
    if (!vm?.loop) return false;
    vm.loop.stop('stopped_by_human');
    return true;
  }

  /** Resolves when the VM has no running loop. */
  async function idle(vmId) {
    const running = vms.get(vmId)?.running;
    if (running) await running;
  }

  /** Room mode: stop every loop, refuse new jobs and let run() resolve. */
  function close(reason = 'fleet_closed') {
    closed = true;
    stop(reason);
    releaseClose();
  }

  return Object.freeze({
    run, stop, board, startJob, stopVm, idle, close,
    isBusy: (vmId) => Boolean(vms.get(vmId)?.loop),
    spentUsd: () => Math.round(total() * 1e6) / 1e6,
  });
}
