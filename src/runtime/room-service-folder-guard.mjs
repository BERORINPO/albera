import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

// Who may change the folder `claude.exe` is started from (docs/architecture/control-plane-service.md sections 3 and 8; zaku SEC-001 of #185). The room service starts that file with a credential in
// its environment, so a copy that the Control Plane or an ordinary user could replace would be a way to read the token. This is the same test the .NET host's PathGuard.cs applies to what IT starts
// (node.exe, the app tree, the settings file), in the same terms:
//   - the owner of the folder (and of the file) is LocalSystem, BUILTIN\Administrators or TrustedInstaller,
//   - no other principal has an Allow ACE with write-data, append-data (add-file / add-subdirectory), delete-child, delete, write-DAC or write-owner (or the generic write / all bits),
//     inherit-only ACEs included. The Control Plane's own service SID is "other". CREATOR OWNER counts as trusted (it only resolves to whoever creates the object, which the write rights cover),
//   - the DACL is not NULL, and
//   - neither the path nor any of its parents is a reparse point (junction, symlink, mount point).
// It is asked before EVERY run (the files are not watched), for the executable and for every folder from its parent up to the install folder. Anything that stops the check from finishing is
// "not trusted". BCL types only through Windows PowerShell (no cmdlet: the first cmdlet lookup can cost 22 s, see windows-acl.mjs); nothing here changes any ACL. The path travels on stdin.
// Where the install folder is: room-service-config.mjs CLAUDE_INSTALL_DIR (a fixed path, never an environment variable).

const POWERSHELL_RELATIVE_PATH = path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TIMEOUT_MS = 30_000;
const MAX_PATHS = 16;
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $null = [System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  $in = [System.Web.Script.Serialization.JavaScriptSerializer]::new().DeserializeObject([Console]::In.ReadToEnd())
  $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-0')
  $mask = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
  function HasReparse($p) {
    for ($c = $p; $c; $c = [System.IO.Path]::GetDirectoryName($c)) {
      if (([System.IO.File]::GetAttributes($c) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
    }
    return $false
  }
  function IsTrusted($security) {
    $d = [System.Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
    if (($null -eq $d.Owner) -or ($null -eq $d.DiscretionaryAcl)) { return $false }
    if ($trusted -notcontains $d.Owner.Value) { return $false }
    foreach ($ace in $d.DiscretionaryAcl) {
      if (([string]$ace.AceType) -notlike 'AccessAllowed*') { continue }
      if ($ace -isnot [System.Security.AccessControl.KnownAce]) { return $false }
      if ((($ace.AccessMask -band $mask) -ne 0) -and ($trusted -notcontains $ace.SecurityIdentifier.Value)) { return $false }
    }
    return $true
  }
  $ok = $true
  foreach ($p in @($in['folders'])) {
    $p = [string]$p
    if ((HasReparse $p) -or -not (IsTrusted ([System.IO.DirectoryInfo]::new($p).GetAccessControl()))) { $ok = $false }
  }
  $f = [string]$in['file']
  if ((HasReparse $f) -or -not (IsTrusted ([System.IO.FileInfo]::new($f).GetAccessControl()))) { $ok = $false }
  if ($ok) { exit 0 } else { exit 1 }
} catch { exit 1 }
`;
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64');

/** The folders to check for an executable: its parent, every parent up to `installDir` (inclusive). `[]` when it is not inside `installDir`. Pure; Windows path rules. */
export function foldersToGuard(executable, installDir) {
  const w = path.win32;
  if (!w.isAbsolute(executable) || !w.isAbsolute(installDir)) return [];
  const root = w.resolve(installDir).toLowerCase();
  const rel = w.relative(root, w.resolve(executable).toLowerCase());
  if (rel === '' || rel.startsWith('..') || w.isAbsolute(rel)) return [];
  const folders = [];
  for (let dir = w.dirname(w.resolve(executable)); ; dir = w.dirname(dir)) {
    folders.push(dir);
    if (dir.toLowerCase() === root) return folders;
    if (folders.length > MAX_PATHS || w.dirname(dir) === dir) return [];
  }
}

/**
 * The real guard: `check(executable) -> Promise<boolean>`, true only when the executable and its folders up to `installDir` pass the test above. Windows only; elsewhere false.
 * @param {{ installDir: string, platform?: string, spawnImpl?: Function }} options
 */
export function createWindowsFolderGuard({ installDir, platform = process.platform, spawnImpl = spawn } = {}) {
  return Object.freeze({
    check(executable) {
      const folders = foldersToGuard(String(executable), installDir);
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT; // the OS directory, to find powershell.exe; not a credential
      if (platform !== 'win32' || folders.length === 0 || !systemRoot || !path.win32.isAbsolute(systemRoot)) return Promise.resolve(false);
      return new Promise((resolve) => {
        let child;
        let timer;
        const done = (ok) => { clearTimeout(timer); try { child?.kill(); } catch { /* already gone */ } resolve(ok); };
        try {
          child = spawnImpl(path.win32.join(systemRoot, POWERSHELL_RELATIVE_PATH), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT], {
            windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
            env: { SystemRoot: systemRoot, windir: systemRoot, PATH: path.win32.join(systemRoot, 'System32'), PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') },
          });
        } catch { resolve(false); return; }
        timer = setTimeout(() => done(false), TIMEOUT_MS);
        child.once('error', () => done(false));
        child.once('close', (code) => done(code === 0));
        child.stdin.once('error', () => {}); // an early exit is reported by 'close'
        child.stdin.end(JSON.stringify({ folders, file: String(executable) }));
      });
    },
  });
}
