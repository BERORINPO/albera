// Allowlist for everything that feeds the approver app build (arch rule 11e). A denylist of "dangerous" elements is not enough: an extra Sdk, an Import, a UsingTask, an analyzer,
// a Directory.Build.props above the project or a nuget.config can all add restored or executable inputs while a denylist stays green. So the csproj may contain exactly the elements and
// values below, nothing may sit between the project directory and the repository root that MSBuild or NuGet would pick up on its own, and the project directory holds only known files.
import fs from 'node:fs';
import path from 'node:path';

export const APPROVER_PROJECT_DIR = 'src/runtime/windows-approver';
export const PINNED_SDK_PACK = '10.0.19041.57'; // Microsoft.Windows.SDK.NET.Ref, restored by the Windows target framework

const ALLOWED_ELEMENTS = new Set(['Project', 'PropertyGroup', 'ItemGroup', 'Compile', 'Target', 'Error', 'OutputType', 'TargetFramework', 'WindowsSdkPackageVersion', 'AssemblyName', 'RootNamespace',
  'ImplicitUsings', 'Nullable', 'TreatWarningsAsErrors', 'InvariantGlobalization', 'RuntimeIdentifiers', 'DefaultItemExcludes', 'DefineConstants']);
const EXACT_VALUES = { OutputType: 'Exe', TargetFramework: 'net10.0-windows10.0.19041.0', WindowsSdkPackageVersion: PINNED_SDK_PACK, AssemblyName: 'AlberaApprover', RootNamespace: 'Albera.Approver',
  ImplicitUsings: 'enable', Nullable: 'enable', TreatWarningsAsErrors: 'true', InvariantGlobalization: 'true', RuntimeIdentifiers: 'win-x64' };
const ALLOWED_COMPILE = new Set(['Include=../broker-contract/*.cs', 'Remove=TestSeam.cs', 'Remove=WindowsHello.cs']);
const AMBIENT_FILES = /^(?:Directory\.(?:Build|Solution)\.(?:props|targets|rsp)|Directory\.Packages\.props|global\.json|nuget\.config|packages\.config|Directory\.Build\.\w+)$/iu;
const ALLOWED_PROJECT_DIR_FILE = /\.cs$|^Albera\.Approver\.csproj$|^packages\.lock\.json$/u;

/** @returns {string[]} one message per violation; empty when the approver build inputs are exactly the allowed ones. */
export function checkApproverBuildInputs(root) {
  const violations = [];
  const fail = (message) => violations.push(`[11e Approver build inputs] ${message}`);
  const projectDir = path.join(root, APPROVER_PROJECT_DIR);
  const projectFile = path.join(projectDir, 'Albera.Approver.csproj');
  if (!fs.existsSync(projectFile)) return [`[11e Approver build inputs] ${APPROVER_PROJECT_DIR}/Albera.Approver.csproj does not exist (false-safe)`];

  const xml = fs.readFileSync(projectFile, 'utf8').replace(/<!--[\s\S]*?-->/gu, '');
  const tags = [...xml.matchAll(/<(\/?)([A-Za-z_][\w.]*)([^>]*?)(\/?)>/gu)].filter((m) => m[1] === '');
  if (!/^\s*<Project Sdk="Microsoft\.NET\.Sdk">/u.test(xml)) fail('the project element must be exactly <Project Sdk="Microsoft.NET.Sdk"> (no other Sdk, no Sdk version)');
  if ([...xml.matchAll(/\bSdk\s*=/gu)].length !== 1) fail('an Sdk attribute or <Sdk> element other than the one on <Project> is not allowed');
  for (const [, , name, attributes] of tags) {
    if (!ALLOWED_ELEMENTS.has(name)) fail(`element <${name}> is not in the allowlist (PackageReference, Analyzer, UsingTask, Import, ProjectReference, Exec, ... are all refused)`);
    if (name === 'Compile') {
      const key = attributes.match(/^\s*(Include|Remove)="([^"]*)"/u);
      if (!key || !ALLOWED_COMPILE.has(`${key[1]}=${key[2]}`)) fail(`<Compile${attributes}> is not one of the allowed items`);
    }
    if (name === 'Target' && !/^\s*Name="RefuseInheritedTestSymbol"/u.test(attributes)) fail('the only allowed <Target> is RefuseInheritedTestSymbol');
  }
  for (const [name, value] of Object.entries(EXACT_VALUES)) {
    const found = [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'gu'))].map((m) => m[1]);
    if (found.length !== 1 || found[0] !== value) fail(`<${name}> must appear once with the value ${value} (found: ${found.join(', ') || 'none'}) (false-safe)`);
  }
  if (!/<Compile Remove="WindowsHello\.cs" Condition="'\$\(AlberaApproverTestFaults\)' == 'true'"/u.test(xml)) fail('the test-faults build must not compile WindowsHello.cs (tests must never reach the real Hello)');
  const target = xml.match(/<Target\b[\s\S]*?<\/Target>/u)?.[0] ?? '';
  if ([...target.matchAll(/<(?!\/)([A-Za-z_][\w.]*)/gu)].map((m) => m[1]).join(',') !== 'Target,Error') fail('the RefuseInheritedTestSymbol target may contain only its <Error> task');

  // Files that MSBuild or NuGet pick up by themselves, from the project directory up to the repository root.
  for (let dir = projectDir; ; dir = path.dirname(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && AMBIENT_FILES.test(entry.name)) fail(`${path.relative(root, path.join(dir, entry.name)).replaceAll('\\', '/')} would be picked up by the approver build (ambient MSBuild / NuGet input)`);
    }
    if (path.resolve(dir) === path.resolve(root)) break;
  }
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (entry.name === 'bin' || entry.name === 'obj') continue;
    if (!entry.isFile() || !ALLOWED_PROJECT_DIR_FILE.test(entry.name)) fail(`${APPROVER_PROJECT_DIR}/${entry.name} is not an allowed project-directory entry (only .cs files, Albera.Approver.csproj and packages.lock.json)`);
  }
  return violations;
}
