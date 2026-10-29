import { createDesktopAgentLoop, costOf } from './desktop-agent-loop.mjs';
import {
  PLANNER_SYSTEM_PROMPT, DEFAULT_GOAL_STEPS, MAX_REPLANS, checkPrompt, parsePlannerReply, planNote, planPrompt,
} from './desktop-planner.mjs';

/**
 * Planned agent loop: the planner (a stronger model) writes 1 to 8 sub-goals for the task, then each sub-goal runs as
 * its own short desktop agent loop (the hands see only that sentence, at most `goalMaxSteps` steps), and after each one
 * the planner looks at a fresh screenshot and decides next / replan (at most `maxReplans`) / done / failed.
 *
 * It has the same `run()` / `stop()` and the same events as createDesktopAgentLoop, so the fleet, the board and the room
 * need no change: `step` events (hands steps and planner calls alike) carry the running step number and the running
 * USD of planner + hands, and their `note` starts with `[plan i/n]`; `action` events carry the running step number;
 * one `end` event closes the run. One extra `plan` event `{type: 'plan', revision, goals}` announces each (re)plan;
 * listeners that do not know it ignore it. The planner's DONE / FAILED are claims, exactly like the hands'.
 * `limits` cover the whole run: maxSteps counts hands steps, maxUsd counts planner and hands together.
 */
export function createPlannedAgentLoop({
  driver, client, plannerClient, vmId, lease, task, limits, prices, plannerPrices,
  goalMaxSteps = DEFAULT_GOAL_STEPS, maxReplans = MAX_REPLANS, now = Date.now, onEvent = () => {},
  settleMs = 0, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  if (!driver || typeof driver.capture !== 'function' || typeof driver.act !== 'function') throw new TypeError('invalid_agent_driver');
  if (!client || typeof client.send !== 'function') throw new TypeError('invalid_agent_client');
  if (!plannerClient || typeof plannerClient.send !== 'function') throw new TypeError('invalid_planner_client');
  if (typeof task !== 'string' || task.length < 1) throw new TypeError('invalid_agent_task');
  if (!limits || !isPositive(limits.maxSteps) || !isPositive(limits.maxUsd) || !isPositive(limits.maxMs)) throw new TypeError('invalid_agent_limits');
  if (!validPrices(prices)) throw new TypeError('invalid_agent_prices');
  if (!validPrices(plannerPrices)) throw new TypeError('invalid_planner_prices');
  if (!Number.isSafeInteger(goalMaxSteps) || goalMaxSteps < 1) throw new TypeError('invalid_goal_steps');
  if (!Number.isSafeInteger(maxReplans) || maxReplans < 0 || maxReplans > MAX_REPLANS) throw new TypeError('invalid_max_replans');

  const abort = new AbortController();
  let stopReason = null;
  let hands = null;
  const emit = (event) => { try { onEvent(Object.freeze(event)); } catch { /* a listener must not break the loop */ } };

  function stop(reason = 'stopped') {
    if (stopReason !== null) return;
    stopReason = String(reason).slice(0, 80);
    abort.abort();
    hands?.stop(stopReason);
  }

  async function run() {
    const started = now();
    const elapsed = () => now() - started;
    // steps: every model call (hands and planner); handsSteps: hands only (limits.maxSteps)
    const state = { steps: 0, handsSteps: 0, actions: 0, usd: 0 };
    const plan = { goals: [], index: 0, done: [], replans: 0, revision: -1 };
    const finish = (outcome, { claim = '', reason } = {}) => {
      const result = { outcome, claim, reason, steps: state.steps, actions: state.actions, usd: roundUsd(state.usd), ms: elapsed() };
      emit({ type: 'end', ...result });
      return Object.freeze({ ...result, plan: Object.freeze({ goals: plan.goals.length, confirmed: plan.done.length, replans: plan.replans }) });
    };
    const spent = () => {
      if (state.usd >= limits.maxUsd) return 'max_usd';
      if (elapsed() >= limits.maxMs) return 'max_ms';
      return null;
    };
    const setPlan = (goals) => {
      plan.goals = goals;
      plan.index = 0;
      plan.revision++;
      emit({ type: 'plan', revision: plan.revision, goals: [...goals] });
    };

    /** One planner call on a fresh screenshot. Returns the parsed reply or `{halt}`. */
    async function askPlanner(phase, extra) {
      if (stopReason !== null) return { halt: ['stopped', { reason: stopReason }] };
      const over = spent();
      if (over) return { halt: ['limit_reached', { reason: over }] };
      let image;
      try { image = imageBlock((await driver.capture({ vmId, lease })).png); }
      catch (error) { return { halt: ['error', { reason: safeCode(error) }] }; }
      const messages = phase === 'plan' ? planPrompt({ task, image }) : checkPrompt({ task, image, ...extra });
      state.steps++;
      let response;
      try { response = await plannerClient.send(messages, PLANNER_SYSTEM_PROMPT, { signal: abort.signal }); }
      catch (error) {
        if (stopReason !== null) return { halt: ['stopped', { reason: stopReason }] };
        return { halt: ['error', { reason: safeCode(error) }] };
      }
      state.usd += costOf(response.usage, plannerPrices);
      const reply = parsePlannerReply(response, phase);
      const n = phase === 'plan' && reply.ok ? reply.goals.length : plan.goals.length;
      const i = phase === 'plan' ? 0 : plan.index + 1;
      const said = reply.ok ? `planner ${reply.decision}: ${reply.reason}` : `planner output refused (${reply.code})`;
      emit({ type: 'step', step: state.steps, usd: roundUsd(state.usd), ms: elapsed(), toolUses: 0, stopReason: response.stopReason, note: planNote(i, n, said) });
      if (!reply.ok) return { halt: [reply.code === 'planner_refused' ? 'refused' : 'error', { reason: reply.code }] };
      if (stopReason !== null) return { halt: ['stopped', { reason: stopReason }] };
      return reply;
    }

    /** One sub-goal as its own desktop agent loop. Its events are renumbered and prefixed; its end event is dropped. */
    async function runGoal() {
      const base = state.usd;
      const label = [plan.index + 1, plan.goals.length];
      hands = createDesktopAgentLoop({
        driver, client, vmId, lease, task: plan.goals[plan.index], prices, now, settleMs, sleep,
        limits: { maxSteps: Math.min(goalMaxSteps, limits.maxSteps - state.handsSteps), maxUsd: limits.maxUsd - base, maxMs: limits.maxMs - elapsed() },
        onEvent: (event) => {
          if (event.type === 'step') {
            state.steps++;
            state.usd = base + (Number.isFinite(event.usd) ? event.usd : 0);
            emit({ ...event, step: state.steps, usd: roundUsd(state.usd), ms: elapsed(), note: planNote(...label, event.note) });
          }
          else if (event.type === 'action') emit({ ...event, step: state.steps });
        },
      });
      if (stopReason !== null) hands.stop(stopReason);
      const result = await hands.run();
      hands = null;
      state.usd = base + result.usd;
      state.handsSteps += result.steps;
      state.actions += result.actions;
      return result;
    }

    const first = await askPlanner('plan');
    if (first.halt) return finish(...first.halt);
    if (first.decision === 'failed') return finish('claimed_failed', { claim: `FAILED: ${first.reason}` });
    setPlan(first.goals);

    for (;;) {
      if (stopReason !== null) return finish('stopped', { reason: stopReason });
      if (state.handsSteps >= limits.maxSteps) return finish('limit_reached', { reason: 'max_steps' });
      const over = spent();
      if (over) return finish('limit_reached', { reason: over });

      const result = await runGoal();
      if (stopReason !== null) return finish('stopped', { reason: stopReason });
      if (['stopped', 'error', 'refused'].includes(result.outcome)) return finish(result.outcome, { claim: result.claim, reason: result.reason });
      // A sub-goal that ran out of its own steps goes to the planner; the run's limits end the run.
      if (result.outcome === 'limit_reached' && (result.reason !== 'max_steps' || state.handsSteps >= limits.maxSteps)) {
        return finish('limit_reached', { reason: result.reason });
      }

      const check = await askPlanner('check', {
        done: plan.done, goals: plan.goals, index: plan.index, outcome: result.outcome, claim: result.claim, replansLeft: maxReplans - plan.replans,
      });
      if (check.halt) return finish(...check.halt);
      if (check.decision === 'failed') return finish('claimed_failed', { claim: `FAILED: ${check.reason}` });
      if (check.decision === 'replan') {
        if (plan.replans >= maxReplans) return finish('limit_reached', { reason: 'max_replans' });
        plan.replans++;
        setPlan(check.goals);
        continue;
      }
      plan.done = [...plan.done, plan.goals[plan.index]];
      // "next" after the last sub-goal means the planner saw it finished: still only a claim.
      if (check.decision === 'done' || plan.index + 1 >= plan.goals.length) return finish('claimed_done', { claim: `DONE: ${check.reason}` });
      plan.index++;
    }
  }

  return Object.freeze({ run, stop });
}

function imageBlock(png) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } };
}

function safeCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : 'agent_error';
}
function roundUsd(usd) { return Math.round(usd * 1e6) / 1e6; }
function isPositive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function validPrices(p) { return Boolean(p) && isPositive(p.input) && isPositive(p.output); }
