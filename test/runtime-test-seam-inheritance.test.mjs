import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getUnavailableReason, repositoryRoot } from './helpers/windows-broker-harness.mjs';

// The approver and the Approval Authority pin their test switch off when published, but a compile symbol can also arrive from outside the project (an environment variable
// named DefineConstants, a Directory.Build.props, -p:DefineConstants=...). Such a build must FAIL, not ship the fakes. The csproj assertions run on every OS; the builds
// need the .NET 10 SDK (Windows).
const projects = [
  { name: 'approver', csproj: ['src', 'runtime', 'windows-approver', 'Albera.Approver.csproj'], switchName: 'AlberaApproverTestFaults', symbol: 'ALBERA_APPROVER_TEST_FAULTS' },
  { name: 'Approval Authority', csproj: ['src', 'runtime', 'windows-approval-authority', 'Albera.ApprovalAuthority.csproj'], switchName: 'AlberaAuthorityTestFaults', symbol: 'ALBERA_AUTHORITY_TEST_FAULTS' },
];

for (const project of projects) {
  const file = path.join(repositoryRoot, ...project.csproj);
  const text = readFileSync(file, 'utf8');

  test(`${project.name} csproj: the symbol is defined only under the switch, TestSeam.cs is not compiled without it, and an inherited symbol is an Error`, () => {
    const defines = [...text.matchAll(/<DefineConstants>([^<]*)<\/DefineConstants>/gu)];
    assert.equal(defines.length, 1, 'one place defines the symbol');
    assert.equal(defines[0][1], `$(DefineConstants);${project.symbol}`);
    assert.ok(text.indexOf(defines[0][0]) > text.indexOf(`<PropertyGroup Condition="'$(${project.switchName})' == 'true'">`), 'inside the switch condition');
    assert.match(text, new RegExp(`<Compile Remove="TestSeam\\.cs" Condition="'\\$\\(${project.switchName}\\)' != 'true'" />`, 'u'));
    assert.match(text, new RegExp(`<Target Name="RefuseInheritedTestSymbol" BeforeTargets="BeforeCompile;CoreCompile" Condition="'\\$\\(${project.switchName}\\)' != 'true' and \\$\\(DefineConstants\\.Contains\\('${project.symbol}'\\)\\)">\\s*<Error `, 'u'));
  });

  test(`${project.name}: a build without the switch that inherits the symbol (environment DefineConstants, or -p:DefineConstants) fails; the switch on, or no symbol, builds`,
    { skip: getUnavailableReason(), timeout: 300_000 }, () => {
      const work = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-seam-')));
      try {
        const intermediate = `${path.join(work, 'obj')}${path.sep}`;
        const base = [`--property:BaseIntermediateOutputPath=${intermediate}`, `--property:MSBuildProjectExtensionsPath=${intermediate}`];
        execFileSync('dotnet', ['restore', file, '--locked-mode', '--property:RestorePackagesWithLockFile=true', ...base], { stdio: 'pipe', timeout: 120_000, windowsHide: true });
        const build = (label, args, env = {}) => spawnSync('dotnet', ['build', file, '--configuration', 'Release', '--no-restore', '--output', path.join(work, label), ...base, ...args],
          { encoding: 'utf8', timeout: 180_000, windowsHide: true, env: { ...process.env, ...env } });

        for (const [label, args, env] of [
          ['env', [`--property:${project.switchName}=false`], { DefineConstants: project.symbol }],
          ['env-unset-switch', [], { DefineConstants: project.symbol }],
          ['global', [`--property:${project.switchName}=false`, `--property:DefineConstants=${project.symbol}`], {}],
        ]) {
          const result = build(label, args, env);
          assert.notEqual(result.status, 0, `${label}: the build must fail\n${result.stdout}`);
          assert.match(result.stdout, /ALBERA_SEAM/u, `${label}: it fails with the seam error\n${result.stdout}`);
        }
        const plain = build('plain', [`--property:${project.switchName}=false`]);
        assert.equal(plain.status, 0, `no symbol: the shipped configuration builds\n${plain.stdout}`);
        const faults = build('faults', [`--property:${project.switchName}=true`]);
        assert.equal(faults.status, 0, `the switch on builds with the seam\n${faults.stdout}`);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
}
