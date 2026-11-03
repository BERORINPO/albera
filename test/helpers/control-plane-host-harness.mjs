// Plumbing for the Windows-only Control Plane host tests: build the .NET host into a temp folder, lay out a fake installed tree (a copy of node.exe, a fake
// app tree whose entry script plays `room-service`, data and log folders, the config), start the host and read its output. Nothing here installs, registers or
// elevates anything; no service is touched. The folders are made by makeTrustedTempDirectory, so the host's ACL guard has something it can trust (the test-seam build is told
// to accept the signed-in user in place of the administrators).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const project = path.join(repositoryRoot, 'src', 'runtime', 'windows-control-plane-host', 'Albera.ControlPlaneHost.csproj');

/** Restore (locked) and build the host into `outputDirectory`. `seams` adds the test-only `serve` and `--trust-sid`; the shipped build has neither. @returns {string} the .exe */
export function buildControlPlaneHost(outputDirectory, { seams }) {
  const intermediate = `${outputDirectory}-obj`;
  const properties = [`--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`, `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`];
  execFileSync('dotnet', ['restore', project, '--locked-mode', '--property:RestorePackagesWithLockFile=true', ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
  execFileSync('dotnet', ['build', project, '--configuration', 'Release', '--no-restore', '--output', outputDirectory, `--property:AlberaControlPlaneHostTestSeams=${seams}`, ...properties],
    { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true });
  return path.join(outputDirectory, 'albera-control-plane-host.exe');
}

/** A copy of this process's node.exe in `folder` (it inherits the folder's trusted ACL) and its SHA-256: what setup would record for the node under Program Files. */
export function copyNode(folder) {
  const target = path.join(folder, 'node.exe');
  copyFileSync(process.execPath, target);
  return { path: target, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') };
}

export const DEFAULT_HOST_SETTINGS = Object.freeze({ logMaxBytes: 65_536, maxRestarts: 2, restartDelayMs: 100, stableRunMs: 5000 });

/**
 * Lays out one fake installation under `root/<name>`: app\src\runtime\entry.mjs (the script text given), data, logs and config.json.
 * `host` overrides values of the `host` block (undefined removes a key); `topLevel` adds keys beside it.
 * @returns {{ config: string, app: string, entry: string, data: string, logs: string, settings: object }}
 */
export function makeInstallation(root, name, node, { entry, host = {}, topLevel = {} }) {
  const base = path.join(root, name);
  const app = path.join(base, 'app');
  const entryFile = path.join(app, 'src', 'runtime', 'entry.mjs');
  const data = path.join(base, 'data');
  const logs = path.join(base, 'logs');
  for (const folder of [path.dirname(entryFile), data, logs]) mkdirSync(folder, { recursive: true });
  writeFileSync(entryFile, entry);
  writeFileSync(path.join(app, 'package.json'), '{"type":"module"}\n');
  const settings = { nodePath: node.path, nodeSha256: node.sha256, appPath: app, dataRoot: data, logDirectory: logs, ...DEFAULT_HOST_SETTINGS, ...host };
  for (const key of Object.keys(settings)) if (settings[key] === undefined) delete settings[key];
  const config = path.join(base, 'config.json');
  writeFileSync(config, JSON.stringify({ host: settings, ...topLevel }));
  return { config, app, entry: entryFile, data, logs, settings };
}

/** Prelude of every fake entry: records one run (argv, cwd, environment) under the data root it was given, in the order of the runs. */
export const RECORD_RUN = `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(1);
const dataRoot = argv[argv.indexOf('--data-root') + 1];
fs.appendFileSync(path.join(dataRoot, 'runs.txt'), process.pid + '\\n');
fs.writeFileSync(path.join(dataRoot, 'last-run.json'), JSON.stringify({ argv, cwd: process.cwd(), env: process.env, pid: process.pid }));
`;

/** A fake entry that records its run and then stays alive until it is killed. */
export const ENTRY_STAYS_ALIVE = `${RECORD_RUN}\nsetInterval(() => {}, 1000);\n`;

/** A fake entry that records its run and exits at once with `code`. */
export const entryExits = (code) => `${RECORD_RUN}\nprocess.exit(${code});\n`;

/** A fake entry that lives `milliseconds` and then exits with code 1. */
export const entryLivesFor = (milliseconds) => `${RECORD_RUN}\nsetTimeout(() => process.exit(1), ${milliseconds});\n`;

/** A fake entry that starts a grandchild (another node) and writes both PIDs to pids.json under the data root; then stays alive. */
export const ENTRY_WITH_GRANDCHILD = `${RECORD_RUN}
import { spawn } from 'node:child_process';
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(dataRoot, 'pids.json'), JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`;

/** A fake entry that writes about 300 KB to each of stdout and stderr, ends with a marker line, and then stays alive. */
export const ENTRY_NOISY = `${RECORD_RUN}
const line = (stream, n) => stream + ' line ' + String(n).padStart(6, '0') + ' ' + 'x'.repeat(80) + '\\n';
for (let n = 0; n < 3000; n++) { process.stdout.write(line('out', n)); process.stderr.write(line('err', n)); }
process.stdout.write('END-OF-OUTPUT out\\n');
process.stderr.write('END-OF-OUTPUT err\\n');
setInterval(() => {}, 1000);
`;

/** True while a process with this PID exists (the PIDs come from the host's own children; the test stops polling long before a PID could be reused). */
export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Polls `read` until it returns a truthy value or `timeoutMs` passes. @returns the value, or undefined on timeout. */
export async function eventually(read, timeoutMs = 15_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = read(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
