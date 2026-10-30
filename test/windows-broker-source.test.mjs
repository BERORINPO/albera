import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source-level guards for the Host Broker prototype (ADR-002 Proposed / NOT VERIFIED). They run on every OS and need no .NET SDK.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const program = read('src', 'runtime', 'windows-broker', 'Program.cs');
const project = read('src', 'runtime', 'windows-broker', 'Albera.WindowsBroker.csproj');
const publish = read('scripts', 'publish-windows-broker.mjs');

test('Broker source stays a fixed-action prototype with no process launch, service or Hyper-V code', () => {
  assert.deepEqual([...program.matchAll(/action != "([^"]+)"/gu)].map((m) => m[1]), ['synthetic.noop']);
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /ServiceBase/u, /ServiceController/u, /\bsc\.exe\b/u, /powershell/iu, /Hyper-?V/iu, /Get-VM/u, /SetAccessControl/u, /AddAccessRule/u, /PipeSecurity/u]) {
    assert.equal(forbidden.test(program), false, `Program.cs must not match ${forbidden}`);
  }
  assert.match(program, /PipeOptions\.CurrentUserOnly/u, 'the prototype pipe stays ephemeral and current-user-only');
});

test('Broker project asks for no elevation, no service wrapper and no extra package', () => {
  assert.equal(/ApplicationManifest|requestedExecutionLevel|WindowsService|UseWindowsServices/iu.test(project), false);
  assert.deepEqual([...project.matchAll(/<PackageReference Include="([^"]+)" Version="([^"]+)"/gu)].map((m) => `${m[1]}@${m[2]}`), ['Microsoft.Data.Sqlite@10.0.14']);
  assert.match(project, /<AssemblyName>albera-windows-broker<\/AssemblyName>/u);
});

test('Broker publish script only builds, writes a SHA-256 manifest and does not install or start anything', () => {
  assert.match(publish, /RestoreLockedMode=true/u);
  assert.match(publish, /\.manifest\.json/u);
  assert.match(publish, /captureExecutableIdentity/u);
  assert.equal(/spawn(?:Sync)?\(\s*(?:broker|output)\b/u.test(publish), false);
  assert.equal(/\bsc(?:\.exe)?\b|New-Service|Start-Process|runas|schtasks|icacls|Set-Acl/iu.test(publish), false);
});
