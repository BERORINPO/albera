import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The Broker and the Approval Authority each create their pipes through LocalPipe.cs (CreateNamedPipeW), because .NET's NamedPipeServerStreamAcl
// cannot set PIPE_REJECT_REMOTE_CLIENTS: the VM lab (issue #23, check u6, 2026-11-01) opened the Broker pipe through \\127.0.0.1 with an account on
// its DACL. The two projects do not reference each other, so the file is copied; this test keeps the copies equal and the flags pinned. The
// behaviour (first instance only, owner, DACL) is exercised by the Broker and Authority integration tests; the remote refusal by the lab (u6).
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n/gu, '\n');
const broker = read('src', 'runtime', 'windows-broker', 'LocalPipe.cs');
const authority = read('src', 'runtime', 'windows-approval-authority', 'LocalPipe.cs');
const code = (text) => text.split('\n').filter((line) => !/^\s*\/\//u.test(line) && !/^namespace /u.test(line)).join('\n').replace(/\n{2,}/gu, '\n');

test('the Broker and Authority copies of LocalPipe.cs are the same code (comments and the namespace aside)', () => {
  assert.equal(code(authority), code(broker));
  assert.match(authority, /^namespace Albera\.ApprovalAuthority;$/mu);
  assert.equal(/^namespace /mu.test(broker), false, 'the Broker project has no namespace');
});

test('LocalPipe creates the first and only instance, byte mode, and rejects remote clients', () => {
  assert.match(broker, /PipeRejectRemoteClients = 0x00000008/u);
  assert.match(broker, /internal const uint PipeMode = PipeTypeByte \| PipeReadModeByte \| PipeWait \| PipeRejectRemoteClients;/u);
  assert.match(broker, /FileFlagFirstPipeInstance = 0x00080000/u);
  // The two-argument Create (the Broker's claim pipe, the Authority's pipes) is the first instance with max 1; the Broker's desktop pipe asks for 16 (DesktopPipe.cs) and passes firstInstance only for its first.
  assert.match(broker, /Create\(string pipeName, PipeSecurity security\) => Create\(pipeName, security, 1, firstInstance: true\);/u, 'the default is the first and only instance');
  assert.match(broker, /uint openMode = PipeAccessDuplex \| FileFlagOverlapped \| \(firstInstance \? FileFlagFirstPipeInstance : 0\);/u, 'the first-instance flag is set exactly when the caller says it creates the first instance');
  assert.match(broker, /CreateNamedPipeW\(@"\\\\\.\\pipe\\" \+ pipeName, openMode, PipeMode, maxInstances, 0, 0, 0, ref attributes\)/u, 'local namespace only, remote clients rejected for every instance');
  assert.match(broker, /InheritHandle = 0/u, 'the handle is not inherited by child processes');
  assert.match(broker, /if \(error == ErrorAccessDenied\) throw new UnauthorizedAccessException\(\);/u, 'a taken name keeps mapping to exit 70');
  for (const [name, file, creation] of [
    ['Broker', read('src', 'runtime', 'windows-broker', 'Program.cs'), /LocalPipe\.Create\(pipeName, OwnedBySelf\(out SecurityIdentifier self, allowedSid\), maxInstances, firstInstance\)/u],
    ['Authority', read('src', 'runtime', 'windows-approval-authority', 'PipeHost.cs'), /LocalPipe\.Create\(pipeName, OwnedBySelf\(out SecurityIdentifier self, allowedSid\)\)/u],
  ]) {
    assert.equal(/NamedPipeServerStreamAcl\.Create\(/u.test(file), false, `${name} never uses the .NET call`);
    assert.match(file, creation, `${name} creates its pipe through LocalPipe`);
  }
  assert.match(read('src', 'runtime', 'windows-broker', 'Program.cs'), /CreateBrokerPipe\(string pipeName, string allowedSid, out int failure, uint maxInstances = 1, bool firstInstance = true\)/u, 'the claim pipe keeps the defaults: first instance, max 1');
});
