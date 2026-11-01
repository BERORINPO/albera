# Issue #23 lab, GUEST side: a stand-in for the PERSON's own Windows account, the account Main AI and the Observer run under on a real host.
# Runs INSIDE the disposable lab VM as Administrator (Windows PowerShell 5.1), called by lab-guest.ps1. ASCII only. Never run it on a host.
#   lab-person.ps1 -Create -UserName <n> -ServiceName <s> -BinPath <cmd>   a local user in BUILTIN\Users only (no other group), the logon-as-a-service
#                                                                          right for it, and an own-process demand-start service that runs <cmd> as that user
#   lab-person.ps1 -Remove -UserName <n>                                   the right, the user and its profile (delete the service first)
# Prints one JSON line. The password is random, lives only in this process and goes to the SCM through New-Service -Credential (never a command line,
# a file or the output); nothing ever needs it again, because the service is the only way the lab runs anything as this user.
# Why a service: the lab drives the guest over PowerShell Direct, where nothing can start an interactive logon. A service logon token carries SERVICE
# where an interactive one carries INTERACTIVE; lab-guest.ps1 check u5 therefore also reads every protected object's DACL for INTERACTIVE, Users,
# Authenticated Users and Everyone, so the difference cannot hide a grant.
param(
  [switch]$Create,
  [switch]$Remove,
  [Parameter(Mandatory = $true)][ValidatePattern('^AlberaLab[A-Za-z]{1,10}$')][string]$UserName,
  [string]$ServiceName,
  [string]$BinPath
)
$ErrorActionPreference = 'Stop'
if ($Create -eq $Remove) { throw 'give exactly one of -Create or -Remove' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AlberaLabLsa
{
    [StructLayout(LayoutKind.Sequential)] struct LsaString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct LsaObjectAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
    [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LsaObjectAttributes attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LsaString[] rights, uint count);
    [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, bool all, LsaString[] rights, uint count);
    [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
    [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
    const uint PolicyCreateAccount = 0x10, PolicyLookupNames = 0x800;

    // Adds (add = true) or removes exactly one right for one SID. Returns the Win32 error, 0 on success.
    public static int Change(byte[] sid, string right, bool add)
    {
        LsaObjectAttributes attributes = new LsaObjectAttributes();
        IntPtr policy;
        uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyCreateAccount | PolicyLookupNames, out policy);
        if (status != 0) return LsaNtStatusToWinError(status);
        IntPtr text = Marshal.StringToHGlobalUni(right);
        try
        {
            LsaString[] rights = { new LsaString { Buffer = text, Length = (ushort)(right.Length * 2), MaximumLength = (ushort)((right.Length + 1) * 2) } };
            status = add ? LsaAddAccountRights(policy, sid, rights, 1) : LsaRemoveAccountRights(policy, sid, false, rights, 1);
            return status == 0 ? 0 : LsaNtStatusToWinError(status);
        }
        finally { Marshal.FreeHGlobal(text); LsaClose(policy); }
    }
}
'@

$right = 'SeServiceLogonRight'
function Get-SidBytes([string]$sidText) { $s = New-Object System.Security.Principal.SecurityIdentifier($sidText); $b = New-Object byte[] ($s.BinaryLength); $s.GetBinaryForm($b, 0); $b }

if ($Create) {
  if ([string]::IsNullOrWhiteSpace($ServiceName) -or [string]::IsNullOrWhiteSpace($BinPath)) { throw '-Create needs -ServiceName and -BinPath' }
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) { throw "local user $UserName already exists; refusing to touch it" }
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { throw "service $ServiceName already exists; refusing to touch it" }
  # 32 random bytes as base64 plus fixed characters from every class the default password policy asks for.
  $bytes = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secure = ([Convert]::ToBase64String($bytes) + 'aA1!') | ConvertTo-SecureString -AsPlainText -Force
  $user = New-LocalUser -Name $UserName -Password $secure -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description 'ALBERA lab person stand-in (disposable VM)'
  Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
  $sid = $user.SID.Value
  $err = [AlberaLabLsa]::Change((Get-SidBytes $sid), $right, $true)
  if ($err -ne 0) { throw "LsaAddAccountRights $right failed ($err)" }
  $credential = New-Object System.Management.Automation.PSCredential(".\$UserName", $secure)
  New-Service -Name $ServiceName -BinaryPathName $BinPath -Credential $credential -StartupType Manual | Out-Null
  $groups = @(Get-LocalGroup | Where-Object { @(Get-LocalGroupMember -Group $_ -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $sid }).Count -gt 0 } | ForEach-Object { $_.SID.Value })
  [ordered]@{ created = $true; userSid = $sid; groups = $groups; right = $right; service = $ServiceName } | ConvertTo-Json -Compress
  return
}

$report = [ordered]@{ removed = $false; rightRemoved = $false; profileRemoved = $false; userAbsent = $false }
$user = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
if ($user) {
  $sid = $user.SID.Value
  $report.rightRemoved = ([AlberaLabLsa]::Change((Get-SidBytes $sid), $right, $false) -eq 0)
  # A service logon loads a profile; delete it through WMI (which also removes its registry entry), never by path.
  $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
  if (-not $profile) { $report.profileRemoved = $true }
  else { try { $profile | Remove-CimInstance; $report.profileRemoved = $true } catch { $report.profileRemoved = $false } }   # still loaded: the VM is deleted anyway
  Remove-LocalUser -SID $sid
  $report.removed = $true
}
$report.userAbsent = -not (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)
$report | ConvertTo-Json -Compress
