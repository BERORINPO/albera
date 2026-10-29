param(
  [Parameter(Mandatory)] [int] $ImageIndex,
  [string] $Dir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$sec = Join-Path $Dir 'local-secrets'
$pw = (Get-Content (Join-Path $sec 'admin-password.txt') -Raw).Trim()
$xml = (Get-Content (Join-Path $PSScriptRoot 'autounattend.template.xml') -Raw).Replace('__ADMIN_PASSWORD__', [Security.SecurityElement]::Escape($pw)).Replace('__IMAGE_INDEX__', "$ImageIndex")
$stage = Join-Path $sec 'unattend-stage'
New-Item -ItemType Directory -Force $stage | Out-Null
Set-Content -Encoding utf8 (Join-Path $stage 'autounattend.xml') $xml
[xml]$null = $xml

if (-not ('IsoStreamWriter' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class IsoStreamWriter {
  public static void Write(object comStream, string path) {
    IStream s = (IStream)comStream;
    STATSTG st; s.Stat(out st, 1);
    byte[] buf = new byte[65536];
    IntPtr readPtr = Marshal.AllocHGlobal(sizeof(int));
    try {
      using (FileStream fs = File.Create(path)) {
        long left = st.cbSize;
        while (left > 0) {
          s.Read(buf, buf.Length, readPtr);
          int n = Marshal.ReadInt32(readPtr);
          if (n <= 0) break;
          fs.Write(buf, 0, n); left -= n;
        }
      }
    } finally { Marshal.FreeHGlobal(readPtr); }
  }
}
'@
}
$fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$fsi.FileSystemsToCreate = 3   # ISO9660 + Joliet
$fsi.VolumeName = 'UNATTEND'
$fsi.Root.AddTree($stage, $false)
$out = Join-Path $sec 'unattend.iso'
[IsoStreamWriter]::Write($fsi.CreateResultImage().ImageStream, $out)
Remove-Item -Recurse -Force $stage
Get-Item $out | Select-Object FullName, Length
