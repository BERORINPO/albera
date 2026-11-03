import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Runs `body` (PowerShell) in Windows PowerShell 5.1 with ONLY the named functions of a lab guest script defined: they are taken out of the script's syntax tree, so none of the
 * guest-side code that creates services or edits groups runs. `body` sees `$cases` (the parsed `cases` object) and writes its answer with `Write-Output`; the last output line is parsed as JSON.
 */
export function runWithGuestFunctions(guestPath, names, body, cases = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'albera-guest-fn-'));
  try {
    const script = path.join(dir, 'drive.ps1');
    const casesFile = path.join(dir, 'cases.json');
    writeFileSync(script, `
param([string]$Target, [string]$CasesFile)
$ErrorActionPreference = 'Stop'
$wanted = @(${names.map((name) => `'${name}'`).join(', ')})
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Target, [ref]$null, [ref]$null)
$found = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $n.Name }, $true))
if ($found.Count -ne $wanted.Count) { throw 'pure functions missing from the guest script' }
foreach ($f in $found) { . ([scriptblock]::Create($f.Extent.Text)) }
$cases = Get-Content -Raw $CasesFile | ConvertFrom-Json
${body}
`);
    // Escaped to ASCII: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page.
    writeFileSync(casesFile, JSON.stringify(cases).replace(/[^\x00-\x7f]/gu, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, guestPath, casesFile],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    return JSON.parse(output.trim().split(/\r?\n/u).at(-1));
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
