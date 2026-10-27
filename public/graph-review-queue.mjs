// A small, deterministic queue for the canvas review action. It reports only
// graph gaps and never evaluates or scores the checked person's understanding.
import { reviewUnderstandingGaps } from './graph-model.mjs';

/** @param {any} graph @param {Set<string>} sessionIds */
export function firstUnderstandingGapForReview(graph, sessionIds) {
  return reviewUnderstandingGaps(graph, sessionIds)[0] ?? null;
}
