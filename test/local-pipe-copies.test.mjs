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
  assert.match(broker, /CreateNamedPipeW\(@"\\\\\.\\pipe\\" \+ pipeName, PipeAccessDuplex \| FileFlagFirstPipeInstance \| FileFlagOverlapped, PipeMode, 1, 0, 0, 0, ref attributes\)/u, 'local namespace only, max 1 instance');
  assert.match(broker, /InheritHandle = 0/u, 'the handle is not inherited by child processes');
  assert.match(broker, /if \(error == ErrorAccessDenied\) throw new UnauthorizedAccessException\(\);/u, 'a taken name keeps mapping to exit 70');
  for (const [name, file] of [['Broker', read('src', 'runtime', 'windows-broker', 'Program.cs')], ['Authority', read('src', 'runtime', 'windows-approval-authority', 'PipeHost.cs')]]) {
    assert.equal(/NamedPipeServerStreamAcl\.Create\(/u.test(file), false, `${name} never uses the .NET call`);
    assert.match(file, /LocalPipe\.Create\(pipeName, OwnedBySelf\(out SecurityIdentifier self, allowedSid\)\)/u, `${name} creates its pipe through LocalPipe`);
  }
});
