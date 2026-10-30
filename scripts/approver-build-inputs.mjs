// Exact pin for everything that feeds the approver app build (arch rule 11e). A denylist, or an element-by-element allowlist, still leaves room (an attributed duplicate property, a
// Condition, a new item); so the csproj text must equal EXPECTED_CSPROJ below, character for character (only CRLF / LF and trailing newlines are ignored). Any change to the csproj
// therefore has to change this script in the same PR, where a reviewer sees it. Around the csproj: nothing that MSBuild or NuGet picks up on its own may exist from the project directory
// up to the repository root, nothing in that chain may be a symbolic link or junction, and the project directory holds only known files (extra .cs files are code and are reviewed).
import fs from 'node:fs';
import path from 'node:path';

export const APPROVER_PROJECT_DIR = 'src/runtime/windows-approver';

export const EXPECTED_CSPROJ = [
  "<Project Sdk=\"Microsoft.NET.Sdk\">",
  "  <!-- Approver app (ADR-002 \"Receipt v2\" / Approval Authority option B, Proposed / NOT VERIFIED). A console program a human runs to list, approve or deny the Approval",
  "       Authority's pending requests, and to enrol its Windows Hello key. Built only on demand by `npm run build:approver` or the approver tests. Nothing installs, registers",
  "       or starts it. The ONE external dependency is the Windows SDK projection (the WinRT KeyCredentialManager for Windows Hello): the Windows target framework below makes the",
  "       SDK restore the targeting pack Microsoft.Windows.SDK.NET.Ref from NuGet (it is not a PackageReference; WindowsSdkPackageVersion pins it). Everything else is BCL and",
  "       P/Invoke. The receipt v2 / action digest contract is source-included from ../broker-contract (no other project is referenced). See docs/architecture/approver-app.md. -->",
  "  <PropertyGroup>",
  "    <OutputType>Exe</OutputType>",
  "    <TargetFramework>net10.0-windows10.0.19041.0</TargetFramework>",
  "    <!-- The pinned SDK projection pack (Microsoft.Windows.SDK.NET.Ref, a ~12 MB Microsoft-signed download). A newer pack is a reviewed change, not a silent restore. -->",
  "    <WindowsSdkPackageVersion>10.0.19041.57</WindowsSdkPackageVersion>",
  "    <AssemblyName>AlberaApprover</AssemblyName>",
  "    <RootNamespace>Albera.Approver</RootNamespace>",
  "    <ImplicitUsings>enable</ImplicitUsings>",
  "    <Nullable>enable</Nullable>",
  "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
  "    <InvariantGlobalization>true</InvariantGlobalization>",
  "    <RuntimeIdentifiers>win-x64</RuntimeIdentifiers>",
  "    <DefaultItemExcludes>$(DefaultItemExcludes);bin/**;obj/**</DefaultItemExcludes>",
  "  </PropertyGroup>",
  "  <PropertyGroup Condition=\"'$(AlberaApproverTestFaults)' == 'true'\">",
  "    <!-- Test-only: the fake presence signer and key store (in-memory RSA key) and the test options. Only the approver tests pass this property; the publish script pins it",
  "         false, so none of it exists in the shipped binary. The symbol is defined here and nowhere else. -->",
  "    <DefineConstants>$(DefineConstants);ALBERA_APPROVER_TEST_FAULTS</DefineConstants>",
  "  </PropertyGroup>",
  "  <ItemGroup>",
  "    <Compile Include=\"../broker-contract/*.cs\" />",
  "    <!-- The test seam file is not even compiled unless the switch is on. -->",
  "    <Compile Remove=\"TestSeam.cs\" Condition=\"'$(AlberaApproverTestFaults)' != 'true'\" />",
  "    <!-- The Windows Hello code is shipped-only: a test-faults build does not contain it, so no test can reach the real KeyCredentialManager. -->",
  "    <Compile Remove=\"WindowsHello.cs\" Condition=\"'$(AlberaApproverTestFaults)' == 'true'\" />",
  "  </ItemGroup>",
  "  <!-- The symbol can also arrive from outside (an environment variable named DefineConstants, a Directory.Build.props, -p:DefineConstants=...). Pinning the switch",
  "       false does not stop that, so a build without the switch that still carries the symbol fails instead of shipping the fake signer and the identity overrides. -->",
  "  <Target Name=\"RefuseInheritedTestSymbol\" BeforeTargets=\"BeforeCompile;CoreCompile\" Condition=\"'$(AlberaApproverTestFaults)' != 'true' and $(DefineConstants.Contains('ALBERA_APPROVER_TEST_FAULTS'))\">",
  "    <Error Code=\"ALBERA_SEAM\" Text=\"ALBERA_APPROVER_TEST_FAULTS is defined but AlberaApproverTestFaults is not true: refusing to build the test seam into a non-test build.\" />",
  "  </Target>",
  "</Project>",
].join('\n');

const AMBIENT_FILES = /^(?:Directory\.(?:Build|Solution)\.\w+|Directory\.Packages\.props|global\.json|nuget\.config|packages\.config)$/iu;
const ALLOWED_PROJECT_DIR_FILE = /\.cs$|^Albera\.Approver\.csproj$|^packages\.lock\.json$/u;
const normalise = (text) => text.replace(/\r\n/gu, '\n').replace(/\n+$/u, '');
const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** @returns {string[]} one message per violation; empty when the approver build inputs are exactly the pinned ones. */
export function checkApproverBuildInputs(root) {
  const violations = [];
  const fail = (message) => violations.push(`[11e Approver build inputs] ${message}`);
  const rel = (p) => path.relative(root, p).replaceAll('\\', '/') || '.';
  const projectDir = path.join(root, APPROVER_PROJECT_DIR);
  const projectFile = path.join(projectDir, 'Albera.Approver.csproj');
  if (!fs.existsSync(projectFile)) return [`[11e Approver build inputs] ${APPROVER_PROJECT_DIR}/Albera.Approver.csproj does not exist (false-safe)`];

  if (normalise(fs.readFileSync(projectFile, 'utf8')) !== EXPECTED_CSPROJ) fail('Albera.Approver.csproj differs from the pinned text in scripts/approver-build-inputs.mjs (change both in the same PR, with review)');

  // The chain from the project directory up to the root: no ambient MSBuild / NuGet file of any kind (a link with such a name counts), and no link anywhere below the root.
  const realRoot = fs.realpathSync.native(root);
  for (let dir = projectDir; ; dir = path.dirname(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (AMBIENT_FILES.test(entry.name)) fail(`${rel(path.join(dir, entry.name))} would be picked up by the approver build (ambient MSBuild / NuGet input)`);
    }
    if (path.resolve(dir) === path.resolve(root)) break;
    if (fs.lstatSync(dir).isSymbolicLink()) fail(`${rel(dir)} is a symbolic link or junction`);
    const expectedReal = path.join(realRoot, path.relative(root, dir));
    if (!sameFile(fs.realpathSync.native(dir), expectedReal)) fail(`${rel(dir)} resolves outside its own path (a link or junction above it)`);
  }
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    const entryPath = path.join(projectDir, entry.name);
    if (fs.lstatSync(entryPath).isSymbolicLink()) { fail(`${rel(entryPath)} is a symbolic link or junction`); continue; }
    if (entry.name === 'bin' || entry.name === 'obj') continue;
    if (!entry.isFile() || !ALLOWED_PROJECT_DIR_FILE.test(entry.name)) fail(`${APPROVER_PROJECT_DIR}/${entry.name} is not an allowed project-directory entry (only .cs files, Albera.Approver.csproj and packages.lock.json)`);
  }
  return violations;
}
