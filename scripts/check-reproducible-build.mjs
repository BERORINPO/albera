#!/usr/bin/env node
// `npm run check:reproducible` (issue #108): proves that two clean builds of the same source give byte-identical output. Slow (every .NET output is built twice) and Windows-only,
// so it is NOT part of `npm test`. It runs the real publish scripts (so the properties, the SDK and the NuGet restore are exactly the shipped ones), and before each run it deletes
// the generated obj/ and bin/ folders of the projects it builds (git-ignored build output, rebuilt right away), so every run is a clean build. After each run it hashes every file
// of every output folder and compares run 1 with run 2.
//   --relocate   also build a copy of the repository at another path and compare it with run 1 (proves the output does not depend on where the repository is checked out).
// Files that may differ are listed with a reason in EXPECTED_EXCLUSIONS (scripts/reproducible-compare.mjs) and are reported, never skipped silently. Exit 0 = reproducible, 1 = a difference or a failed build.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { EXPECTED_EXCLUSIONS, compareSnapshots, formatReport, hashTree, isReproducible } from './reproducible-compare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS_TFM = 'net10.0-windows';
const publishFolder = (project, tfm = WINDOWS_TFM) => `${project}/bin/Release/${tfm}/win-x64/publish`;

/** One entry per publish script: the script to run, the project folders whose obj/ and bin/ are wiped first, and the output folders that are hashed (relative to the repository). */
export const TARGETS = Object.freeze([
  { id: 'job-guardian', script: 'publish-windows-job-guardian.mjs', projects: ['src/runtime/windows-job-guardian', 'test/windows-job-probe'], outputs: [publishFolder('src/runtime/windows-job-guardian'), `test/windows-job-probe/bin/Release/${WINDOWS_TFM}`] },
  { id: 'broker', script: 'publish-windows-broker.mjs', projects: ['src/runtime/windows-broker', 'src/runtime/windows-broker-pipe-client'], outputs: [publishFolder('src/runtime/windows-broker'), publishFolder('src/runtime/windows-broker-pipe-client')] },
  { id: 'approval-authority', script: 'publish-windows-approval-authority.mjs', projects: ['src/runtime/windows-approval-authority'], outputs: [publishFolder('src/runtime/windows-approval-authority')] },
  { id: 'approver', script: 'publish-windows-approver.mjs', projects: ['src/runtime/windows-approver'], outputs: [publishFolder('src/runtime/windows-approver', 'net10.0-windows10.0.19041.0')] },
  { id: 'service-lab', script: 'publish-windows-service-lab.mjs', projects: ['test/windows-service-lab'], outputs: [publishFolder('test/windows-service-lab')] },
]);

const scrub = (folder) => fs.rmSync(folder, { recursive: true, force: true });

/** Clean build of one target in the repository at `base`; @returns {Map<string,string>} output file (prefixed by its folder) -> SHA-256. Exits the process when the build fails. */
function cleanBuild(base, target) {
  for (const project of target.projects) for (const generated of ['obj', 'bin']) scrub(path.join(base, project, generated));
  const result = spawnSync(process.execPath, [path.join(base, 'scripts', target.script)], { cwd: base, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) {
    process.stderr.write(`${target.id}: ${target.script} failed (exit ${result.status ?? result.error?.message})\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    process.exit(1);
  }
  const snapshot = new Map();
  for (const output of target.outputs) for (const [file, hash] of hashTree(path.join(base, output))) snapshot.set(`${output}/${file}`, hash);
  return snapshot;
}

/** Copy of the repository without .git, node_modules, .claude and build output, in a fresh folder of ours under the temp directory. */
function relocatedCopy() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-repro-'));
  const copy = path.join(parent, 'checkout-elsewhere');
  const skipped = /(?:^|[\\/])(?:\.git|\.claude|node_modules|bin|obj)(?:[\\/]|$)/u;
  fs.cpSync(root, copy, { recursive: true, filter: (source) => !skipped.test(path.relative(root, source)) });
  return { parent, copy };
}

function main() {
  if (process.platform !== 'win32') {
    console.log('Reproducible-build check skipped on non-Windows host');
    return 0;
  }
  const relocate = process.argv.includes('--relocate');
  const moved = relocate ? relocatedCopy() : undefined;
  let reproducible = true;
  try {
    for (const target of TARGETS) {
      const exclusions = EXPECTED_EXCLUSIONS.filter((entry) => entry.target === target.id).map(({ file, reason }) => ({ file, reason }));
      const first = cleanBuild(root, target);
      const second = cleanBuild(root, target);
      const comparisons = [[`${target.id}: run 1 vs run 2 (same path)`, compareSnapshots(first, second, exclusions)]];
      if (moved) comparisons.push([`${target.id}: run 1 vs a copy at another path`, compareSnapshots(first, cleanBuild(moved.copy, target), exclusions)]);
      for (const [label, result] of comparisons) {
        console.log(formatReport(label, result).join('\n'));
        reproducible &&= isReproducible(result);
      }
    }
  } finally {
    if (moved) scrub(moved.parent);
  }
  console.log(`expected exclusions configured: ${EXPECTED_EXCLUSIONS.length}`);
  console.log(reproducible ? 'Reproducible: every output file is byte-identical across clean builds' : 'NOT reproducible: see the DIFFERENT lines above');
  return reproducible ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
