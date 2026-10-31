// Pure comparison and reporting for `npm run check:reproducible` (issue #108). It hashes folders and compares two hash maps; it never runs dotnet,
// so test/reproducible-compare.test.mjs covers every decision here without a build.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Output files that are KNOWN to differ between two builds of the same source, with the reason. Matched by target id and by the file's path relative to its output folder.
 * A file listed here is reported as an "expected exclusion" and does not fail the check; it is never silently skipped. Empty on purpose: with the properties from
 * dotnet-build-env.mjs (reproducibilityProperties) every file of every output was byte-identical on SDK 10.0.302, including the apphost exe (no signature or timestamp is written).
 * @type {ReadonlyArray<{ target: string, file: string, reason: string }>}
 */
export const EXPECTED_EXCLUSIONS = Object.freeze([]);

/** @returns {Map<string,string>} relative path (forward slashes, sorted) -> SHA-256 of every file under `directory`; throws when the folder is missing or empty (a check on nothing would pass). */
export function hashTree(directory) {
  const entries = new Map();
  const walk = (folder) => {
    for (const dirent of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else if (dirent.isFile()) entries.set(path.relative(directory, full).replaceAll('\\', '/'), createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
      else throw new Error(`unsupported_entry: ${full} is neither a regular file nor a folder`);
    }
  };
  if (!fs.existsSync(directory)) throw new Error(`missing_output: ${directory}`);
  walk(directory);
  if (entries.size === 0) throw new Error(`empty_output: ${directory}`);
  return new Map([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Compares two hash maps (relative path -> SHA-256).
 * @param {{ file: string, reason: string }[]} [exclusions] files allowed to differ (already narrowed to this target).
 * @returns {{ identical: string[], different: string[], excluded: { file: string, reason: string }[], onlyInFirst: string[], onlyInSecond: string[] }}
 *   `different` are the unexpected mismatches; a file present on one side only is never excluded (a missing output is not a reproducibility detail).
 */
export function compareSnapshots(first, second, exclusions = []) {
  const reasons = new Map(exclusions.map(({ file, reason }) => [file, reason]));
  const result = { identical: [], different: [], excluded: [], onlyInFirst: [], onlyInSecond: [] };
  for (const [file, hash] of first) {
    if (!second.has(file)) result.onlyInFirst.push(file);
    else if (second.get(file) === hash) result.identical.push(file);
    else if (reasons.has(file)) result.excluded.push({ file, reason: reasons.get(file) });
    else result.different.push(file);
  }
  for (const file of second.keys()) if (!first.has(file)) result.onlyInSecond.push(file);
  return result;
}

/** @returns {boolean} true when nothing unexpected differs (excluded files are fine; missing or extra files are not). */
export function isReproducible(result) {
  return result.different.length === 0 && result.onlyInFirst.length === 0 && result.onlyInSecond.length === 0;
}

/** @returns {string[]} the report lines for one comparison: the verdict, then every problem and every expected exclusion. `label` names what was compared (e.g. "broker: run 1 vs run 2"). */
export function formatReport(label, result) {
  const lines = [`${isReproducible(result) ? 'IDENTICAL' : 'DIFFERENT'} ${label}: ${result.identical.length} identical, ${result.different.length} different, ${result.excluded.length} expected exclusion(s), ${result.onlyInFirst.length + result.onlyInSecond.length} missing on one side`];
  for (const file of result.different) lines.push(`  DIFFERENT ${file}`);
  for (const file of result.onlyInFirst) lines.push(`  ONLY IN FIRST ${file}`);
  for (const file of result.onlyInSecond) lines.push(`  ONLY IN SECOND ${file}`);
  for (const { file, reason } of result.excluded) lines.push(`  EXPECTED EXCLUSION ${file}: ${reason}`);
  return lines;
}
