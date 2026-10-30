// Shared, hardened `dotnet` invocation for every publish script (issue #102). A compromised build machine could otherwise steer the output through
// the caller's environment: a different `dotnet` found on PATH, MSBuild auto-response files (Directory.Build.rsp), MSBUILD* / NuGet* / DOTNET_* variables,
// an environment variable named DefineConstants, or a machine / user NuGet.Config. What this helper does about each:
//   1. dotnet is NOT looked up on PATH: it must be <ProgramFiles>\dotnet\dotnet.exe (a regular file, no link). There is no override variable on purpose: an
//      override would be one more thing a tampered environment can set. (Tests inject their own file system view instead.)
//   2. every MSBuild call gets -noAutoResponse (no .rsp files) and -nologo; -nodeReuse:false keeps no build node alive that could outlive the sanitised environment.
//   3. the child environment is built from an ALLOWLIST (below), not filtered from the caller's: MSBuild*, NuGet*, DOTNET_*, DefineConstants, Albera* and everything
//      else simply are not passed on. PATH is rebuilt as System32 + the dotnet folder. Three DOTNET_* values are set by us (no logo, no telemetry, no first-run work).
//   4. restore is a separate, locked step with the repo's own NuGet config (scripts/nuget.publish.config, --configfile: only nuget.org, nothing else is read);
//      publish / build then runs --no-restore. A project without packages.lock.json is refused rather than restored unlocked.
//   5. after the build the caller prints the SDK version and the output SHA-256 (printBuildIdentity), one line each, so two builds can be compared.
// What it does not do: it does not verify dotnet.exe's signature, and an attacker who can write C:\Program Files already owns the machine.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
export const NUGET_CONFIG = path.join(scriptsDirectory, 'nuget.publish.config');

/** The only variables copied from the caller's environment (matched case-insensitively, as Windows does). */
export const INHERITED_VARIABLES = Object.freeze([
  'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'PATHEXT', 'ComSpec',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS',
]);
/** The DOTNET_* values we set ourselves (nothing else with that prefix gets through). */
export const FIXED_VARIABLES = Object.freeze({ DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' });

const PROGRAM_FILES = /^[A-Za-z]:\\Program Files$/iu;
const lookup = (env, name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

/** @returns {string} the trusted absolute path of dotnet.exe; throws `untrusted_dotnet: ...` (one line) when it is missing or is not at the expected place. */
export function resolveTrustedDotnet({ env = process.env, platform = process.platform, lstat = fs.lstatSync, realpath = fs.realpathSync.native } = {}) {
  if (platform !== 'win32') throw new Error('untrusted_dotnet: the publish scripts only build on Windows');
  const base = String(lookup(env, 'ProgramW6432') ?? lookup(env, 'ProgramFiles') ?? '');
  if (!PROGRAM_FILES.test(base)) throw new Error(`untrusted_dotnet: ProgramFiles is "${base}", expected <drive>:\\Program Files; refusing to look for dotnet anywhere else (PATH is not used)`);
  const dotnet = path.win32.join(base, 'dotnet', 'dotnet.exe');
  let stat;
  try { stat = lstat(dotnet); } catch { throw new Error(`untrusted_dotnet: ${dotnet} does not exist; install the .NET 10 SDK there (a dotnet found only via PATH is refused)`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`untrusted_dotnet: ${dotnet} is not a regular file (a link or directory is refused)`);
  if (realpath(dotnet).toLowerCase() !== dotnet.toLowerCase()) throw new Error(`untrusted_dotnet: ${dotnet} resolves to ${realpath(dotnet)} (a link or junction in its path is refused)`);
  return dotnet;
}

/** @returns {Record<string,string>} a new environment for the child: allowlisted variables, a rebuilt PATH and our fixed DOTNET_* values. */
export function sanitisedEnvironment(env, dotnet) {
  const clean = {};
  for (const name of INHERITED_VARIABLES) {
    const value = lookup(env, name);
    if (value !== undefined && value !== '') clean[name] = String(value);
  }
  const systemRoot = clean.SystemRoot ?? clean.windir;
  if (!systemRoot) throw new Error('untrusted_environment: SystemRoot is not set');
  clean.PATH = [path.win32.join(systemRoot, 'System32'), path.win32.dirname(dotnet)].join(';');
  return { ...clean, ...FIXED_VARIABLES };
}

const MSBUILD_SWITCHES = Object.freeze(['-noAutoResponse', '-nologo', '-nodeReuse:false']);

/** `dotnet restore` arguments: locked, with the repo NuGet config, runtime-specific when `runtime` is given. Throws when the project has no packages.lock.json. */
export function restoreArguments({ project, runtime, properties = [], configFile = NUGET_CONFIG, lockFileExists = (file) => fs.existsSync(file) }) {
  if (!lockFileExists(path.join(path.dirname(project), 'packages.lock.json'))) throw new Error(`missing_lock_file: ${path.join(path.dirname(project), 'packages.lock.json')} (a restore without a lock file is refused)`);
  return ['restore', project, ...MSBUILD_SWITCHES, '--configfile', configFile, ...(runtime ? ['--runtime', runtime] : []), '--locked-mode', ...properties];
}

/** `dotnet publish` / `dotnet build` arguments: never restores (the locked restore ran before). */
export function buildArguments({ verb, project, args = [], properties = [] }) {
  if (verb !== 'publish' && verb !== 'build') throw new Error(`unsupported_verb: ${verb}`);
  return [verb, project, '--no-restore', ...MSBUILD_SWITCHES, ...args, ...properties];
}

/** @returns {{ dotnet: string, env: Record<string,string>, root: string }} the trusted dotnet and its sanitised environment, for `root` as the working directory. */
export function createBuildContext(root, options = {}) {
  const dotnet = resolveTrustedDotnet(options);
  return { dotnet, env: sanitisedEnvironment(options.env ?? process.env, dotnet), root };
}

/** Same as createBuildContext, but a refusal is one line on stderr and exit 1 (what the publish scripts want). */
export function createBuildContextOrExit(root) {
  try { return createBuildContext(root); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}

function run(context, label, args) {
  const result = spawnSync(context.dotnet, args, { cwd: context.root, env: context.env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true });
  if (result.error || result.status !== 0) {
    process.stderr.write(`${label} failed\n`);
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

/** Locked restore, then `publish` (or `build`) --no-restore; exits the process with dotnet's status on failure. */
export function restoreAndBuild(context, { label, verb = 'publish', project, runtime, properties = [], args = [] }) {
  let restore;
  try { restore = restoreArguments({ project, runtime, properties }); } catch (error) { process.stderr.write(`${label}: ${error.message}\n`); process.exit(1); }
  run(context, `${label} restore`, restore);
  run(context, `${label} ${verb}`, buildArguments({ verb, project, args, properties }));
}

/** @returns {string} `dotnet --version` of the trusted dotnet, in the sanitised environment. */
export function sdkVersion(context) {
  return run(context, 'dotnet --version', ['--version']).trim();
}

/** The two comparison lines: SDK version and SHA-256 of the main output (relative to `root`). */
export function printBuildIdentity({ sdk, root, file, sha256, log = console.log }) {
  log(`dotnet sdk ${sdk}`);
  log(`sha256 ${sha256} ${path.relative(root, file).replaceAll('\\', '/')}`);
}
