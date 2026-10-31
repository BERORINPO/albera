// Fetches the two Windows SDK tools the MSIX packaging needs (makeappx.exe to pack, signtool.exe to sign) from ONE pinned NuGet package and refuses anything that does not match (issue #101).
//   - the package is Microsoft.Windows.SDK.BuildTools, exactly 10.0.28000.2705, from api.nuget.org over https. The owner approved this one download; it is NOT a PackageReference of any
//     project and never reaches a build. The pinned value below is the nupkg's SHA-512 (base64). The file is downloaded into a fresh, empty folder of ours (under the temp folder,
//     removed at exit), hashed WHILE it is written, and deleted unread when the hash differs. Nothing is extracted before the hash matched.
//   - only <binFolder> (bin/10.0.28000.0/x64) is extracted, with the fixed C:\Windows\System32\tar.exe (bsdtar, which refuses ".." members), into another fresh folder of ours.
//   - makeappx.exe and signtool.exe must then carry a VALID Authenticode signature by "Microsoft Corporation" (Get-AuthenticodeSignature through the fixed Windows PowerShell path, with a
//     minimal environment); anything else is refused. The program files that are not those two are only loaded by them as DLLs; the hash of the package covers them.
// Not covered: the temp folders are only as private as the user's temp folder (another process of the same account could swap a tool after the check and before the run; the same
// limit as scripts/dotnet-build-env.mjs); the signature check is the machine's own trust store; a newer tool version is a reviewed change of the pin, never a silent one.
// Everything that touches the network, the file system or a process is injectable, so test/approver-msix.test.mjs runs without any of them.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const BUILD_TOOLS = Object.freeze({
  id: 'Microsoft.Windows.SDK.BuildTools',
  version: '10.0.28000.2705',
  sha512Base64: '47kp42eMb8rF3bjDuZHVkzGRb9Fr7wyFZDIT2sWr3StwnTCoDHIisDe0SPWGwerwVUw/eQQO/OxDb0YYHbfNvA==',
  url: 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/10.0.28000.2705/microsoft.windows.sdk.buildtools.10.0.28000.2705.nupkg',
  binFolder: 'bin/10.0.28000.0/x64',
  tools: Object.freeze(['makeappx.exe', 'signtool.exe']),
  maxBytes: 600 * 1024 * 1024,
});
export const SYSTEM_ROOT = 'C:\\Windows';
export const TAR_EXE = `${SYSTEM_ROOT}\\System32\\tar.exe`;
export const POWERSHELL_EXE = `${SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
export const SIGNER_SUBJECT = /^CN=Microsoft Corporation(?:,|$)/u;
const SIGNATURE_SCRIPT = '$s = Get-AuthenticodeSignature -LiteralPath $env:ALBERA_TOOL_PATH; [pscustomobject]@{ status = $s.Status.ToString(); subject = $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { "" }) } | ConvertTo-Json -Compress';

/** A minimal child environment: fixed Windows locations, our temp folder, and the extra variables the caller names. Nothing is inherited. */
export function minimalEnvironment(temp, extra = {}) {
  return { SystemRoot: SYSTEM_ROOT, windir: SYSTEM_ROOT, PATH: `${SYSTEM_ROOT}\\System32`, TEMP: temp, TMP: temp, ...extra };
}

/** @returns {string} the SHA-512 (base64) of `bytes` in one go; used by the tests. */
export const sha512Base64 = (bytes) => createHash('sha512').update(bytes).digest('base64');

/** Creates a fresh empty folder under the temp folder and removes it when the process exits. */
export function ownedTempFolder(prefix, { tmpdir = os.tmpdir } = {}) {
  const folder = fs.mkdtempSync(path.join(tmpdir(), prefix));
  process.once('exit', () => { try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* a leftover temp folder is harmless: the next run makes its own */ } });
  return folder;
}

/**
 * Downloads the pinned nupkg to `file`, hashing while writing. Throws `buildtools_download: ...` for a bad status or size and `buildtools_hash_mismatch` (the file is deleted) when the SHA-512 differs.
 * @param {{ file: string, fetchImpl?: typeof fetch, pin?: typeof BUILD_TOOLS }} options
 * @returns {Promise<{ bytes: number, sha512Base64: string }>}
 */
export async function downloadPinned({ file, fetchImpl = fetch, pin = BUILD_TOOLS }) {
  const response = await fetchImpl(pin.url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`buildtools_download: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > pin.maxBytes) throw new Error(`buildtools_download: ${declared} bytes is over the ${pin.maxBytes} byte limit`);
  const hash = createHash('sha512');
  const out = fs.createWriteStream(file, { flags: 'wx' });
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > pin.maxBytes) throw new Error(`buildtools_download: more than ${pin.maxBytes} bytes`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
  } catch (error) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw error;
  }
  const actual = hash.digest('base64');
  if (actual !== pin.sha512Base64) {
    fs.rmSync(file, { force: true });
    throw new Error(`buildtools_hash_mismatch: ${pin.id} ${pin.version} has SHA-512 ${actual}, expected ${pin.sha512Base64}; the file was deleted unread`);
  }
  return { bytes, sha512Base64: actual };
}

/** `tar -xf <nupkg> -C <folder> <binFolder>` with the fixed bsdtar; throws `buildtools_extract: ...` on failure. @param {{ nupkg: string, folder: string, temp: string, run?: Function, pin?: typeof BUILD_TOOLS }} options */
export function extractTools({ nupkg, folder, temp, run = spawnSync, pin = BUILD_TOOLS }) {
  const result = run(TAR_EXE, ['-xf', nupkg, '-C', folder, pin.binFolder], { env: minimalEnvironment(temp), encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`buildtools_extract: tar failed (${result.error?.message ?? `exit ${result.status}`})`);
  return pin.tools.map((tool) => path.join(folder, ...pin.binFolder.split('/'), tool));
}

/** @returns {{ status: string, subject: string }} the Authenticode status and signer subject of `file` (read with the fixed Windows PowerShell). Throws `buildtools_signature: ...` when it cannot be read. */
export function readSignature({ file, temp, run = spawnSync }) {
  const result = run(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', SIGNATURE_SCRIPT], { env: minimalEnvironment(temp, { ALBERA_TOOL_PATH: file }), encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`buildtools_signature: could not read the signature of ${path.basename(file)}`);
  try {
    const parsed = JSON.parse(String(result.stdout).trim());
    return { status: String(parsed.status), subject: String(parsed.subject) };
  } catch { throw new Error(`buildtools_signature: unreadable answer for ${path.basename(file)}`); }
}

/** Throws unless every file is Authenticode status Valid and signed by Microsoft Corporation. */
export function requireMicrosoftSignature(files, { temp, run = spawnSync } = {}) {
  for (const file of files) {
    const { status, subject } = readSignature({ file, temp, run });
    if (status !== 'Valid') throw new Error(`buildtools_signature: ${path.basename(file)} has Authenticode status ${status}, not Valid`);
    if (!SIGNER_SUBJECT.test(subject)) throw new Error(`buildtools_signature: ${path.basename(file)} is signed by "${subject}", not by Microsoft Corporation`);
  }
}

/**
 * Fetch (hash-checked), extract, signature-check. Returns the paths of makeappx.exe and signtool.exe and the child environment to run them with.
 * @param {{ fetchImpl?: Function, run?: Function, makeFolder?: (prefix: string) => string, pin?: typeof BUILD_TOOLS, log?: (line: string) => void }} [options]
 */
export async function prepareBuildTools({ fetchImpl = fetch, run = spawnSync, makeFolder = ownedTempFolder, pin = BUILD_TOOLS, log = console.log } = {}) {
  const downloads = makeFolder('albera-buildtools-download-');
  const tools = makeFolder('albera-buildtools-');
  const nupkg = path.join(downloads, `${pin.id}.${pin.version}.nupkg`);
  log(`downloading ${pin.id} ${pin.version} (pinned SHA-512, checked before anything is extracted)`);
  const { bytes } = await downloadPinned({ file: nupkg, fetchImpl, pin });
  log(`sha512 verified (${bytes} bytes)`);
  const [makeappx, signtool] = extractTools({ nupkg, folder: tools, temp: downloads, run, pin });
  requireMicrosoftSignature([makeappx, signtool], { temp: downloads, run });
  log('makeappx.exe and signtool.exe: Authenticode Valid, signed by Microsoft Corporation');
  return { makeappx, signtool, env: minimalEnvironment(downloads) };
}
