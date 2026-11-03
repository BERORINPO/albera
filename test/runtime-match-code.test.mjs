import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MATCH_CODE_DOMAIN, MatchCodeError, computeMatchChoices, computeMatchCode, matchCodePreimage,
} from '../src/runtime/broker-contract/match-code.mjs';

// Match code v1 (display aid: the room and the approver app show the same 4 digits). The vectors are shared with the C# twin
// (test/runtime-match-code-dotnet.test.mjs). Here: the Node side of every vector, and the properties the contract names.
const contractDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'runtime', 'broker-contract');
const vectorFile = JSON.parse(fs.readFileSync(path.join(contractDir, 'match-code-vectors.json'), 'utf8'));
const { vectors } = vectorFile;
const validVectors = vectors.filter((v) => v.expected.ok);
const invalidVectors = vectors.filter((v) => !v.expected.ok);

/** The verdict shape shared with the C# harness (test/match-code-dotnet-harness). */
export function runMatchCodeVector({ approvalId, actionDigest }) {
  try {
    const { choices, correctIndex } = computeMatchChoices(approvalId, actionDigest);
    const preimage = matchCodePreimage(approvalId, actionDigest);
    return {
      ok: true, matchCode: computeMatchCode(approvalId, actionDigest), choices: [...choices], correctIndex,
      preimageHex: preimage.toString('hex'), hashHex: createHash('sha256').update(preimage).digest('hex'),
    };
  } catch (error) {
    if (error instanceof MatchCodeError) return { ok: false, code: error.code, field: error.field };
    throw error;
  }
}

test('vector file: shape and coverage of the cases the contract names', () => {
  assert.equal(vectorFile.contract, 'albera.match-code.vectors');
  assert.equal(vectorFile.domain, MATCH_CODE_DOMAIN);
  assert.equal(new Set(vectors.map((v) => v.name)).size, vectors.length, 'vector names are unique');
  assert.ok(validVectors.length >= 20 && invalidVectors.length >= 20);
  const names = new Set(vectors.map((v) => v.name));
  for (const required of ['leading-zeros', 'decoy1-collides-with-correct', 'decoy2-collides-with-correct', 'decoy2-collides-with-decoy1', 'decoy1-wraps-9999-to-0000', 'decoy2-wraps-9999-to-0000', 'approval-id-uppercase', 'digest-hex-uppercase',
    'approval-id-trailing-newline', 'digest-trailing-newline', 'approval-id-null', 'both-invalid-approval-id-reported-first']) assert.ok(names.has(required), `vector ${required} exists`);
  assert.ok(validVectors.some((v) => v.expected.matchCode.startsWith('0')), 'a code with a leading zero is pinned');
  for (const position of [0, 1, 2]) assert.ok(validVectors.some((v) => v.expected.correctIndex === position), `the correct code appears at index ${position}`);
});

test('every vector gives the pinned code, candidates, order, preimage bytes and hash (or the pinned refusal)', () => {
  for (const vector of vectors) assert.deepEqual(runMatchCodeVector(vector), vector.expected, vector.name);
});

test('the preimage is domain + 0x00 + approvalId + 0x00 + actionDigest, and the code is the top 32 bits of its SHA-256 modulo 10000', () => {
  const [{ approvalId, actionDigest }] = validVectors;
  const preimage = matchCodePreimage(approvalId, actionDigest);
  assert.deepEqual(preimage, Buffer.concat([Buffer.from('albera.match-code.v1'), Buffer.of(0), Buffer.from(approvalId), Buffer.of(0), Buffer.from(actionDigest)]));
  const hash = createHash('sha256').update(preimage).digest();
  assert.equal(computeMatchCode(approvalId, actionDigest), String(hash.readUInt32BE(0) % 10000).padStart(4, '0'));
});

test('every valid vector: 4 digits, three distinct candidates, the correct code among them at correctIndex, and it is the same code as computeMatchCode', () => {
  for (const { name, approvalId, actionDigest } of validVectors) {
    const { code, choices, correctIndex } = computeMatchChoices(approvalId, actionDigest);
    assert.match(code, /^[0-9]{4}$/u, name);
    assert.equal(choices.length, 3, name);
    assert.equal(new Set(choices).size, 3, `${name}: the candidates do not overlap`);
    for (const choice of choices) assert.match(choice, /^[0-9]{4}$/u, name);
    assert.equal(choices[correctIndex], code, name);
    assert.equal(code, computeMatchCode(approvalId, actionDigest), name);
  }
});

test('the decoys come from other ranges of the same hash (shifted by +1 only on a collision), never from another approval', () => {
  for (const { name, approvalId, actionDigest } of validVectors) {
    const hash = createHash('sha256').update(matchCodePreimage(approvalId, actionDigest)).digest();
    const { code, choices } = computeMatchChoices(approvalId, actionDigest);
    const decoys = choices.filter((c) => c !== code).map(Number).sort((a, b) => a - b);
    const bases = [4, 8].map((o) => hash.readUInt32BE(o) % 10000);
    for (const decoy of decoys) assert.ok(bases.some((base) => (decoy - base + 10000) % 10000 <= 2), `${name}: decoy ${decoy} is a shifted slice of the hash`);
  }
  // The collision vectors really exercise the shift.
  const byName = Object.fromEntries(validVectors.map((v) => [v.name, v]));
  for (const name of ['decoy1-collides-with-correct', 'decoy2-collides-with-correct', 'decoy2-collides-with-decoy1']) {
    const { approvalId, actionDigest } = byName[name];
    const hash = createHash('sha256').update(matchCodePreimage(approvalId, actionDigest)).digest();
    const [a, b, c] = [0, 4, 8].map((o) => hash.readUInt32BE(o) % 10000);
    assert.ok(b === a || c === a || c === b, `${name}: the raw slices collide`);
  }
});

test('deterministic and pure: the same input gives the same answer; a different approval or digest gives a different preimage; results are frozen', () => {
  const [{ approvalId, actionDigest }] = validVectors;
  assert.deepEqual(computeMatchChoices(approvalId, actionDigest), computeMatchChoices(approvalId, actionDigest));
  const other = validVectors[1];
  assert.notDeepEqual(matchCodePreimage(approvalId, actionDigest), matchCodePreimage(other.approvalId, other.actionDigest));
  const result = computeMatchChoices(approvalId, actionDigest);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.choices));
});

test('the shuffle is part of the contract: the correct code is not stuck in one place', () => {
  const positions = new Map();
  for (const { approvalId, actionDigest } of validVectors.filter((v) => v.name.startsWith('spread-'))) {
    const { correctIndex } = computeMatchChoices(approvalId, actionDigest);
    positions.set(correctIndex, (positions.get(correctIndex) ?? 0) + 1);
  }
  assert.equal(positions.size, 3);
});

test('invalid input throws MatchCodeError naming the field (approvalId is checked first), from every entry point', () => {
  const goodId = validVectors[0].approvalId;
  const goodDigest = validVectors[0].actionDigest;
  for (const call of [computeMatchCode, computeMatchChoices, matchCodePreimage]) {
    assert.throws(() => call('nope', goodDigest), (e) => e instanceof MatchCodeError && e.code === 'invalid_match_input' && e.field === 'approvalId');
    assert.throws(() => call(goodId, 'nope'), (e) => e instanceof MatchCodeError && e.code === 'invalid_match_input' && e.field === 'actionDigest');
    assert.throws(() => call(), (e) => e instanceof MatchCodeError && e.field === 'approvalId');
    assert.throws(() => call(goodId, undefined), (e) => e instanceof MatchCodeError && e.field === 'actionDigest');
    assert.throws(() => call({ toString: () => goodId }, goodDigest), (e) => e instanceof MatchCodeError && e.field === 'approvalId');
  }
});
