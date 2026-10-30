import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { APPROVER_PROJECT_DIR, checkApproverBuildInputs } from '../scripts/approver-build-inputs.mjs';

// Arch rule 11e is an allowlist of every input of the approver build. These tests copy the real project files into a temp "repository" and add one forbidden thing at a time:
// each must make the check fail, and the untouched copy must pass. Runs on any OS; no .NET needed.
const realRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projectName = 'Albera.Approver.csproj';
const realProject = readFileSync(path.join(realRoot, APPROVER_PROJECT_DIR, projectName), 'utf8');

describe('arch rule 11e: the approver build inputs are an allowlist', () => {
  let base;
  let counter = 0;
  before(() => { base = mkdtempSync(path.join(os.tmpdir(), 'albera-11e-')); });
  after(() => rmSync(base, { recursive: true, force: true }));

  /** A fresh copy of the approver project directory inside a fake repository root; `csproj` replaces the project text when given. */
  function fakeRepo(csproj = realProject) {
    const root = path.join(base, `repo-${counter += 1}`);
    const dir = path.join(root, APPROVER_PROJECT_DIR);
    mkdirSync(path.dirname(dir), { recursive: true });
    cpSync(path.join(realRoot, APPROVER_PROJECT_DIR), dir, { recursive: true, filter: (source) => !/[\\/](?:bin|obj)(?:[\\/]|$)/u.test(source) });
    writeFileSync(path.join(dir, projectName), csproj);
    return { root, dir };
  }
  const withElement = (xml, where = '</Project>') => realProject.replace(where, `${xml}\n${where}`);

  it('the real repository passes, and so does an untouched copy', () => {
    assert.deepEqual(checkApproverBuildInputs(realRoot), []);
    assert.deepEqual(checkApproverBuildInputs(fakeRepo().root), []);
  });

  const forbiddenProjects = {
    'a PackageReference': withElement('<ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup>'),
    'an Analyzer': withElement('<ItemGroup><Analyzer Include="evil.dll" /></ItemGroup>'),
    'a UsingTask': withElement('<UsingTask TaskName="Evil" AssemblyFile="evil.dll" />'),
    'an Import': withElement('<Import Project="evil.targets" />'),
    'an implicit-SDK Sdk element': withElement('<Sdk Name="Evil.Sdk" Version="1.0.0" />'),
    'an Sdk attribute on another element': withElement('<Import Project="x.props" Sdk="Evil.Sdk" />'),
    'a ProjectReference': withElement('<ItemGroup><ProjectReference Include="../windows-broker/Albera.WindowsBroker.csproj" /></ItemGroup>'),
    'a FrameworkReference': withElement('<ItemGroup><FrameworkReference Include="Microsoft.WindowsDesktop.App.WindowsForms" /></ItemGroup>'),
    'an Exec task in the existing target': realProject.replace('<Error Code=', '<Exec Command="calc.exe" /><Error Code='),
    'a second Target': withElement('<Target Name="Extra" BeforeTargets="Build"><Exec Command="calc.exe" /></Target>'),
    'an extra Compile item': withElement('<ItemGroup><Compile Include="../../elsewhere/*.cs" /></ItemGroup>'),
    'a restore source property': withElement('<PropertyGroup><RestoreSources>https://evil.example/v3/index.json</RestoreSources></PropertyGroup>'),
    'an attributed duplicate of the pinned property': realProject.replace('</PropertyGroup>', '  <WindowsSdkPackageVersion Condition="\'$(Evil)\' == \'1\'">99.0.0.0</WindowsSdkPackageVersion>\n  </PropertyGroup>'),
    'a Condition added to an existing property': realProject.replace('<OutputType>', '<OutputType Condition="\'$(Evil)\' == \'1\'">'),
    'a changed comment': realProject.replace('Approver app (ADR-002', 'Approver app changed (ADR-002'),
    'a different Sdk': realProject.replace('Sdk="Microsoft.NET.Sdk"', 'Sdk="Microsoft.NET.Sdk.Web"'),
    'an Sdk with a version': realProject.replace('Sdk="Microsoft.NET.Sdk"', 'Sdk="Microsoft.NET.Sdk/9.9.9"'),
    'a different pinned SDK projection version': realProject.replace('10.0.19041.57', '10.0.19041.99'),
    'a missing pinned SDK projection version': realProject.replace(/\s*<WindowsSdkPackageVersion>[^<]*<\/WindowsSdkPackageVersion>/u, ''),
    'a different target framework': realProject.replace('net10.0-windows10.0.19041.0', 'net10.0-windows10.0.22621.0'),
    'the Hello file compiled into the test-faults build': realProject.replace(/\s*<Compile Remove="WindowsHello\.cs"[^>]*\/>/u, ''),
  };
  for (const [label, csproj] of Object.entries(forbiddenProjects)) {
    it(`fails on ${label}`, () => {
      const violations = checkApproverBuildInputs(fakeRepo(csproj).root);
      assert.ok(violations.length > 0, `${label} must make rule 11e fail`);
      assert.ok(violations.every((v) => v.startsWith('[11e Approver build inputs]')));
    });
  }

  const ambient = ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'Directory.Solution.props', 'global.json', 'nuget.config', 'NuGet.Config', 'Directory.Build.rsp'];
  const levels = { 'the project directory': [], 'src/runtime': ['src', 'runtime'], src: ['src'], 'the repository root': [] };
  for (const [level, segments] of Object.entries(levels)) {
    for (const name of ambient) {
      it(`fails on ${name} in ${level}`, () => {
        const { root, dir } = fakeRepo();
        const target = level === 'the project directory' ? dir : path.join(root, ...segments);
        writeFileSync(path.join(target, name), '<Project />');
        const violations = checkApproverBuildInputs(root);
        assert.ok(violations.some((v) => v.includes(name)), `${name} in ${level} must be reported: ${violations.join(' | ')}`);
      });
    }
  }

  for (const name of ['extra.props', 'extra.targets', 'app.config', 'Other.csproj', 'NuGet.config.txt']) {
    it(`fails on an unknown file ${name} in the project directory`, () => {
      const { root, dir } = fakeRepo();
      writeFileSync(path.join(dir, name), '<Project />');
      assert.ok(checkApproverBuildInputs(root).length > 0);
    });
  }

  it('accepts CRLF line ends and a trailing newline in the project text (only those are normalised)', () => {
    assert.deepEqual(checkApproverBuildInputs(fakeRepo(`${realProject.replace(/\r?\n$/u, '').replace(/\r?\n/gu, '\r\n')}\r\n\r\n`).root), []);
  });

  describe('links and junctions are refused', () => {
    /** Try to make a link; resolves false (and the test is skipped) if the OS refuses without privileges. */
    function tryLink(target, linkPath, type) {
      try { symlinkSync(target, linkPath, type); return true; } catch { return false; }
    }

    it('a linked entry in the project directory (file link, directory junction)', (t) => {
      const { root, dir } = fakeRepo();
      writeFileSync(path.join(base, 'outside.cs'), 'class Outside {}');
      if (!tryLink(path.join(base, 'outside.cs'), path.join(dir, 'Linked.cs'), 'file')) return t.skip('this OS refused to create a file symlink');
      assert.ok(checkApproverBuildInputs(root).some((v) => v.includes('Linked.cs') && v.includes('symbolic link')));
    });

    it('a linked directory entry (obj) in the project directory', (t) => {
      const { root, dir } = fakeRepo();
      mkdirSync(path.join(base, 'elsewhere'), { recursive: true });
      if (!tryLink(path.join(base, 'elsewhere'), path.join(dir, 'obj'), 'junction')) return t.skip('this OS refused to create a directory link');
      assert.ok(checkApproverBuildInputs(root).some((v) => v.includes('obj') && v.includes('symbolic link')));
    });

    it('a linked directory above the project (src/runtime points somewhere else)', (t) => {
      const { root } = fakeRepo();
      const runtime = path.join(root, 'src', 'runtime');
      renameSync(runtime, path.join(root, 'src', 'runtime-real'));
      if (!tryLink(path.join(root, 'src', 'runtime-real'), runtime, 'junction')) return t.skip('this OS refused to create a directory link');
      assert.ok(checkApproverBuildInputs(root).some((v) => v.includes('src/runtime') && /symbolic link|resolves outside/u.test(v)));
    });

    it('a linked ambient file (Directory.Build.props as a link) is still reported by name', (t) => {
      const { root } = fakeRepo();
      writeFileSync(path.join(base, 'evil.props'), '<Project />');
      if (!tryLink(path.join(base, 'evil.props'), path.join(root, 'Directory.Build.props'), 'file')) return t.skip('this OS refused to create a file symlink');
      assert.ok(checkApproverBuildInputs(root).some((v) => v.includes('Directory.Build.props')));
    });
  });

  it('reports a missing project instead of passing (false-safe)', () => {
    const root = path.join(base, 'empty');
    mkdirSync(root, { recursive: true });
    assert.match(checkApproverBuildInputs(root)[0], /does not exist \(false-safe\)/u);
  });
});
