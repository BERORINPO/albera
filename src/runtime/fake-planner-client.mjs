import { createFakeComputerUseClient } from './fake-computer-use-client.mjs';

/**
 * Fake planner client for tests: the same scripted queue as the fake computer-use client (responses, Errors or
 * functions), recording a deep copy of every request. `fakeDecision` builds a planner reply as JSON text.
 */
export function createFakePlannerClient(script = []) {
  return createFakeComputerUseClient(script);
}

export function fakeDecision(decision, { goals = [], reason = '', usage = { input_tokens: 100, output_tokens: 10 }, stopReason = 'end_turn' } = {}) {
  return { content: [{ type: 'text', text: JSON.stringify({ decision, goals, reason }) }], stopReason, usage };
}

export function fakePlannerText(text, { usage = { input_tokens: 100, output_tokens: 10 }, stopReason = 'end_turn' } = {}) {
  return { content: [{ type: 'text', text }], stopReason, usage };
}
