// Read-only Windows DACL verification for Runtime audit storage.
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const POWERSHELL_RELATIVE_PATH = path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const MAX_ACL_BATCH_TARGETS = 32;
const MAX_ACL_BATCH_INPUT_BYTES = 32 * 1024;
const MAX_ACL_BATCH_OUTPUT_BYTES = 256 * 1024;
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targets = ConvertFrom-Json -InputObject $env:ALBERA_ACL_TARGETS -ErrorAction Stop
if ($targets.Count -lt 1 -or $targets.Count -gt 32) { throw 'invalid_acl_target_count' }
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$results = @(
  foreach ($p in $targets) {
    $acl = Get-Acl -LiteralPath $p -ErrorAction Stop
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)
    $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($sddl)
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      [pscustomobject]@{
        sid = $_.IdentityReference.Value
        allow = ($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow)
        rights = [int64]$_.FileSystemRights
      }
    })
    [pscustomobject]@{
      path = $p
      owner = $owner
      currentUser = $currentUser
      daclPresent = ($null -ne $raw.DiscretionaryAcl)
      rules = $rules
    }
  }
)
ConvertTo-Json -InputObject $results -Compress -Depth 4
`;
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64');
const ALLOWED_SIDS = new Set([SYSTEM_SID, ADMINISTRATORS_SID]);

export class RuntimeStorageAclError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * Fail closed if a Windows Runtime storage object grants another principal data or ACL access.
 * No ACL is changed. Same-user, LocalSystem, and local Administrators ACEs are accepted.
 */
export async function assertPrivateWindowsAcl(targetPath, { kind = 'file', platform = process.platform, inspect = inspectWindowsAcl, statTarget = lstat } = {}) {
  if (platform !== 'win32') return;
  if (typeof targetPath !== 'string' || !path.win32.isAbsolute(targetPath) || !['file', 'directory'].includes(kind)) {
    throw new RuntimeStorageAclError('runtime_storage_acl_check_failed');
  }
  let stat;
  try { stat = await statTarget(targetPath); }
  catch (error) { throw new RuntimeStorageAclError(error?.code === 'ENOENT' ? 'runtime_storage_acl_target_missing' : 'runtime_storage_acl_check_failed'); }
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new RuntimeStorageAclError('runtime_storage_acl_target_invalid');
  }

  let descriptor;
  try { descriptor = await inspect(targetPath); }
  catch { throw new RuntimeStorageAclError('runtime_storage_acl_check_failed'); }
  if (typeof descriptor?.daclPresent !== 'boolean' || typeof descriptor.currentUser !== 'string' || typeof descriptor.owner !== 'string'
    || !Array.isArray(descriptor.rules)) throw new RuntimeStorageAclError('runtime_storage_acl_check_failed');
  if (!descriptor.daclPresent) throw new RuntimeStorageAclError('runtime_storage_acl_not_private');
  const allowed = new Set([...ALLOWED_SIDS, descriptor.currentUser]);
  if (!allowed.has(descriptor.owner)) throw new RuntimeStorageAclError('runtime_storage_acl_not_private');

  let currentUserHasFullControl = false;
  const externalSafeMask = 0x00100020; // execute/traverse and synchronize do not permit reading or changing stored data
  for (const rule of descriptor.rules) {
    if (!rule || typeof rule.sid !== 'string' || typeof rule.allow !== 'boolean' || !Number.isSafeInteger(rule.rights) || rule.rights < 0) {
      throw new RuntimeStorageAclError('runtime_storage_acl_check_failed');
    }
    if (!rule.allow) throw new RuntimeStorageAclError('runtime_storage_acl_not_private');
    if (rule.sid === descriptor.currentUser && (rule.rights & 0x001f01ff) === 0x001f01ff) currentUserHasFullControl = true;
    if (!allowed.has(rule.sid) && (rule.rights & ~externalSafeMask) !== 0) {
      throw new RuntimeStorageAclError('runtime_storage_acl_not_private');
    }
  }
  if (!currentUserHasFullControl) throw new RuntimeStorageAclError('runtime_storage_acl_not_private');
}

export async function inspectWindowsAcl(targetPath) {
  const [descriptor] = await inspectWindowsAcls([targetPath]);
  return descriptor;
}

/** Inspect a bounded set of Windows DACLs in one PowerShell process. */
export async function inspectWindowsAcls(targetPaths) {
  if (process.platform !== 'win32') throw new RuntimeStorageAclError('runtime_storage_acl_check_failed');
  if (!Array.isArray(targetPaths) || targetPaths.length < 1 || targetPaths.length > MAX_ACL_BATCH_TARGETS
    || targetPaths.some((target) => typeof target !== 'string' || !path.win32.isAbsolute(target))
    || new Set(targetPaths).size !== targetPaths.length) {
    throw new RuntimeStorageAclError('runtime_storage_acl_check_failed');
  }
  const targetsJson = JSON.stringify(targetPaths);
  if (Buffer.byteLength(targetsJson, 'utf8') > MAX_ACL_BATCH_INPUT_BYTES) throw new RuntimeStorageAclError('runtime_storage_acl_check_failed');
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new RuntimeStorageAclError('runtime_storage_acl_check_failed');
  const executable = path.win32.join(systemRoot, POWERSHELL_RELATIVE_PATH);
  const temp = process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  return new Promise((resolve, reject) => {
    let child;
    let output = '';
    let outputBytes = 0;
    let settled = false;
    let timer;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill();
      reject(new RuntimeStorageAclError('runtime_storage_acl_check_failed'));
    };
    try {
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          SystemRoot: systemRoot,
          windir: systemRoot,
          PATH: path.win32.join(systemRoot, 'System32'),
          TEMP: temp,
          TMP: temp,
          PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
          ALBERA_ACL_TARGETS: targetsJson,
        },
      });
    } catch { fail(); return; }
    child.once('error', fail);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_ACL_BATCH_OUTPUT_BYTES) { fail(); return; }
      output += chunk.toString('utf8');
    });
    child.once('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (code !== 0) { fail(); return; }
      try {
        const parsed = JSON.parse(output.trim());
        const results = Array.isArray(parsed) ? parsed : [parsed];
        if (results.length !== targetPaths.length) throw new Error('acl_result_count_invalid');
        const byPath = new Map();
        for (const result of results) {
          if (!result || typeof result.path !== 'string' || byPath.has(result.path)
            || typeof result.owner !== 'string' || typeof result.currentUser !== 'string'
            || typeof result.daclPresent !== 'boolean' || !Array.isArray(result.rules)) throw new Error('acl_result_invalid');
          byPath.set(result.path, Object.freeze({
            owner: result.owner,
            currentUser: result.currentUser,
            daclPresent: result.daclPresent,
            rules: Object.freeze(result.rules.map((rule) => Object.freeze(rule))),
          }));
        }
        const descriptors = targetPaths.map((target) => {
          const descriptor = byPath.get(target);
          if (!descriptor) throw new Error('acl_result_target_invalid');
          return descriptor;
        });
        settled = true;
        resolve(Object.freeze(descriptors));
      } catch { fail(); }
    });
    timer = setTimeout(fail, 60000);
  });
}
