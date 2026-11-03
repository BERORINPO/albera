// The room's bootstrap file for the service launch route (docs/architecture/control-plane-service.md sections 3 and 4).
// The room host gives every new one-time code to a sink; this module is that sink: `ui\room.json` = {port, code, pid, writtenAt}.
// What the caller decides arrives as arguments: the file path and the ACL (`roomBootstrapAcl`). Writing the file with its ACL is the
// store's job. `createWindowsFileStore` is the real store (.NET through PowerShell: the file is created with its protected DACL, never
// first with an inherited one); `fake-room-bootstrap-file.mjs` is its test double. A test must not make a real ACL in ProgramData.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SID_RE = /^S-1-\d{1,3}(?:-\d{1,10}){1,15}$/;
const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const BOOTSTRAP_RIGHTS = Object.freeze(['Modify', 'Read']);
const WRITE_TIMEOUT_MS = 30_000;
const POWERSHELL_RELATIVE_PATH = path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// .NET types only, no cmdlet (the first cmdlet lookup in Windows PowerShell 5.1 can cost 22 s; see windows-acl.mjs).
// The temporary file is created with the DACL, written, then moved over the target (File.Replace when it exists), so a reader never sees a
// half-written file or a file with an inherited ACL. The payload arrives on stdin, not in the environment or the command line.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$null = [System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$in = [System.Web.Script.Serialization.JavaScriptSerializer]::new().DeserializeObject([Console]::In.ReadToEnd())
$target = [string]$in['path']
$tmp = [string]$in['tmp']
$security = [System.Security.AccessControl.FileSecurity]::new()
$security.SetAccessRuleProtection($true, $false)
foreach ($entry in @($in['entries'])) {
  $rights = if ([string]$entry['right'] -eq 'Modify') { [System.Security.AccessControl.FileSystemRights]::Modify } else { [System.Security.AccessControl.FileSystemRights]::Read }
  $sid = [System.Security.Principal.SecurityIdentifier]::new([string]$entry['sid'])
  $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.AccessControlType]::Allow))
}
$bytes = [System.Text.UTF8Encoding]::new($false).GetBytes([string]$in['text'])
try {
  $stream = [System.IO.File]::Create($tmp, 4096, [System.IO.FileOptions]::None, $security)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
  if ([System.IO.File]::Exists($target)) { [System.IO.File]::Replace($tmp, $target, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $target) }
} finally {
  if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) }
}
`;
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64');

export class RoomBootstrapFileError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * The ACL of the file: protected (nothing inherited), the Control Plane's SID Modify, the shareholder's SID (`approverSid`) Read, nobody else.
 * Measured 2026-11-03 (`cp6_programdata_acl`) with exactly these two entries.
 */
export function roomBootstrapAcl({ cpSid, approverSid } = {}) {
  if (!SID_RE.test(String(cpSid)) || !SID_RE.test(String(approverSid)) || cpSid === approverSid) throw new RoomBootstrapFileError('bootstrap_acl_invalid');
  return Object.freeze({
    protectedDacl: true,
    entries: Object.freeze([Object.freeze({ sid: cpSid, right: 'Modify' }), Object.freeze({ sid: approverSid, right: 'Read' })]),
  });
}

/** Is this an ACL a store may apply? (what `roomBootstrapAcl` makes: protected, 1 to 4 entries, known rights, no SID twice) */
export function validBootstrapAcl(acl) {
  return Boolean(acl) && acl.protectedDacl === true && Array.isArray(acl.entries) && acl.entries.length >= 1 && acl.entries.length <= 4
    && acl.entries.every((e) => e && SID_RE.test(String(e.sid)) && BOOTSTRAP_RIGHTS.includes(e.right))
    && new Set(acl.entries.map((e) => e.sid)).size === acl.entries.length;
}

/**
 * The sink the room host takes as `bootstrapSink`.
 * @param {{filePath: string, acl: object, store: {write(path: string, text: string, acl: object): Promise<void>, remove(path: string): Promise<void>},
 *   pid?: number, now?: () => number}} options
 *   `filePath` and `acl` come from the caller (setup knows the folder and the SIDs); `pid` is the node process that owns the port.
 */
export function createRoomBootstrapFile({ filePath, acl, store, pid = process.pid, now = Date.now } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('filePath must be an absolute path');
  if (!validBootstrapAcl(acl)) throw new TypeError('invalid bootstrap acl');
  if (typeof store?.write !== 'function' || typeof store?.remove !== 'function') throw new TypeError('store needs write() and remove()');
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('pid must be a positive integer');
  return Object.freeze({
    /** Write {port, code, pid, writtenAt} with the ACL. A failure is the fixed code `bootstrap_file_write_failed`. */
    async publish({ port, code } = {}) {
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !CODE_RE.test(String(code))) throw new RoomBootstrapFileError('bootstrap_file_invalid');
      const text = `${JSON.stringify({ port, code, pid, writtenAt: new Date(now()).toISOString() })}\n`;
      try { await store.write(filePath, text, acl); } catch { throw new RoomBootstrapFileError('bootstrap_file_write_failed'); }
    },
    /** Delete the file (it is gone when the room stops). A file that is already gone is not an error. */
    async clear() {
      try { await store.remove(filePath); } catch { throw new RoomBootstrapFileError('bootstrap_file_remove_failed'); }
    },
  });
}

/** The real store: `write` creates the file with its protected DACL (Windows only); `remove` deletes it. */
export function createWindowsFileStore({ platform = process.platform } = {}) {
  return Object.freeze({
    async write(filePath, text, acl) {
      if (platform !== 'win32' || !validBootstrapAcl(acl) || typeof text !== 'string' || text.length > 4096) throw new RoomBootstrapFileError('bootstrap_file_write_failed');
      const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
      await runPowerShell({ path: filePath, tmp, text, entries: acl.entries });
    },
    async remove(filePath) { await fs.promises.rm(filePath, { force: true }); },
  });
}

function runPowerShell(payload) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return Promise.reject(new RoomBootstrapFileError('bootstrap_file_write_failed'));
  const temp = process.env.TEMP ?? process.env.TMP ?? systemRoot;
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    const fail = () => { clearTimeout(timer); child?.kill(); reject(new RoomBootstrapFileError('bootstrap_file_write_failed')); };
    try {
      child = spawn(path.win32.join(systemRoot, POWERSHELL_RELATIVE_PATH), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { SystemRoot: systemRoot, windir: systemRoot, PATH: path.win32.join(systemRoot, 'System32'), TEMP: temp, TMP: temp,
          PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') },
      });
    } catch { fail(); return; }
    timer = setTimeout(fail, WRITE_TIMEOUT_MS);
    child.once('error', fail);
    child.once('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new RoomBootstrapFileError('bootstrap_file_write_failed')); });
    child.stdin.once('error', () => {}); // an early exit is reported by 'close'
    child.stdin.end(JSON.stringify(payload));
  });
}
