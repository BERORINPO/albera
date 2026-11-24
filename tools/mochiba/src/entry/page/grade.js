// Practice answer check: compare the boxes picked with the answer, using nothing but the map data.
// Pure (no DOM, no clock): test/quiz.test.mjs evaluates this file on its own.

/** The longest run of picks that follows the answer's order (those count as right). */
function inOrder(picked, answer) {
  const dp = Array.from({ length: picked.length + 1 }, () => new Array(answer.length + 1).fill(0));
  for (let i = picked.length - 1; i >= 0; i--) {
    for (let j = answer.length - 1; j >= 0; j--) dp[i][j] = picked[i] === answer[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const keep = new Set();
  for (let i = 0, j = 0; i < picked.length && j < answer.length;) {
    if (picked[i] === answer[j]) { keep.add(picked[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return keep;
}

/**
 * Result per box: ok (right) / order (in the answer, out of order) / side (a side trip, not counted) /
 * off (not in the answer) / miss (in the answer, not picked).
 * @param {{kind:'path'|'set', boxes:string[], side:string[]}} q
 * @param {string[]} picks in the order they were picked
 * @returns {Map<string,string>}
 */
function gradePicks(q, picks) {
  const res = new Map();
  const side = new Set(q.side || []);
  const want = new Set(q.boxes);
  const keep = q.kind === 'path' ? inOrder(picks, q.boxes) : null;
  for (const id of picks) {
    if (want.has(id)) res.set(id, !keep || keep.has(id) ? 'ok' : 'order');
    else res.set(id, side.has(id) ? 'side' : 'off');
  }
  for (const id of q.boxes) if (!res.has(id)) res.set(id, 'miss');
  return res;
}
