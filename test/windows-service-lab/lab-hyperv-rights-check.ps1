# Hyper-V rights lab (ADR-002 host Broker, PR2), GUEST side. Runs INSIDE the disposable lab VM as Administrator (Windows PowerShell 5.1), started by
# lab-vm.ps1 -HyperV over PowerShell Direct. ASCII only. Not executed in a VM yet (written 2026-11-03).
#   lab-hyperv-rights-check.ps1 <LabRoot> install-feature   install the Hyper-V role (the host restarts the guest afterwards)
#   lab-hyperv-rights-check.ps1 <LabRoot> run               create an inner VM, run the probe as four service identities, then run the real Broker as a service and use its desktop pipe
#                                                           (checks bd_*, see Invoke-BrokerDesktopLab); print the results as ONE JSON line
#   lab-hyperv-rights-check.ps1 <LabRoot> cleanup           delete the lab services, group memberships and the inner VM (the host calls it only with -KeepVm)
#
# The question: can a service that looks like the Host Broker (virtual account, SeChangeNotifyPrivilege only) call the Hyper-V WMI methods for a screen
# capture and for keyboard / mouse input? The probe (albera-lab-service-shim.exe hyperv <vmGuid>, HyperVProbe.cs) does that with COM late binding, the way
# the C# Broker will. Four service identities, because the unknown is whether a RESTRICTED service SID still works:
#     r_member     sidtype restricted,    member of Hyper-V Administrators (S-1-5-32-578)
#     r_nonmember  sidtype restricted,    not a member
#     u_member     sidtype unrestricted,  member
#     u_nonmember  sidtype unrestricted,  not a member
# Verdicts (see Get-HvVerdict): non-members must be refused (PASS); unrestricted members must succeed (PASS); a restricted member is only MEASURED,
# because that is the open question and either answer is a result. A check that could not be measured is BLOCKED, never a quiet PASS.
# Two of the operations (adapter_capture, adapter_input) run the Broker's real adapter instead of raw WMI calls; they are judged the same way.
# Then (checks bd_*, Broker PR #164 "desktop pipe"): the REAL Broker (albera-windows-broker.exe service <config>) is installed as AlberaHostBroker in the shape the owner decided
# (sidtype unrestricted, member of Hyper-V Administrators, SeChangeNotifyPrivilege only, `computers` = the inner VM), and the lab uses its desktop pipe: the Control Plane
# (restricted, no group) opens a view session and captures a PNG of the inner VM; another caller (member, not the Control Plane) is refused.
# Then the act session and the Broker-held lease (Broker PR #166): an act open is refused before any claim; the lab makes a real task.start claim as the Control Plane (fence ->
# a receipt v2 signed with a throwaway key that is pinned in the Broker's config -> the helper sends it), after which the act open, keyboard input, a wrong generation, the end of
# the session by a second claim, and the loss of the lease at a Broker restart are exercised. Mouse input is only MEASURED: the inner VM has no OS (see bd_cp_act_input_mouse).
# Expected values are in the README; a check that could not be measured is BLOCKED.
# Then (checks bh_*, Broker client PR #168 "helper desktop mode"): the SAME Broker is used through the REAL pipe client helper in desktop mode instead of the lab's own client. The guest has no Node,
# so the shim plays the Node side (albera-lab-service-shim.exe desktop-helper, DesktopHelperClient.cs): it starts the helper exe, sends the frames and reads them back. The Control Plane service
# runs it with the production identity (serviceName + imageSha256 of the Broker file): a view open and capture, and (after a task.start claim) an act open and a keyboard input; without the
# image pin as a control; with a wrong image pin; and, with the Broker stopped, against a squatter that holds the desktop pipe name (the helper must end before it sends a byte).
param(
  [Parameter(Mandatory = $true)][string]$LabRoot,
  [Parameter(Mandatory = $true)][ValidateSet('install-feature', 'run', 'cleanup')][string]$Phase
)
$ErrorActionPreference = 'Stop'

# First statement on purpose: this script creates services and edits a local group. Never on a real machine.
if ($env:ALBERA_LAB_VM -ne '1' -or (Get-CimInstance Win32_ComputerSystem).Model -ne 'Virtual Machine') {
  throw 'refusing to run: this script changes services and local groups, and runs only inside the disposable lab VM (ALBERA_LAB_VM=1 in a Hyper-V guest)'
}

$HvAdminsSid = 'S-1-5-32-578'
$InnerVmName = 'AlberaLabInner'
$Shim = "$LabRoot\bin\shim\albera-lab-service-shim.exe"
$Cells = @(
  @{ Code = 'r_member';    Svc = 'AlberaLabHvRM'; SidType = 'restricted';   Member = $true },
  @{ Code = 'r_nonmember'; Svc = 'AlberaLabHvRN'; SidType = 'restricted';   Member = $false },
  @{ Code = 'u_member';    Svc = 'AlberaLabHvUM'; SidType = 'unrestricted'; Member = $true },
  @{ Code = 'u_nonmember'; Svc = 'AlberaLabHvUN'; SidType = 'unrestricted'; Member = $false }
)
# gate = a step on the way (connect, lookup); sensitive = what the Broker will call; reference = read-only, the Broker never calls it.
# The Broker desktop section (after the four identities above): the REAL Broker as a service of the shape ADR-002 Amendment 2026-11-03 decides, and clients of its desktop pipe.
#   AlberaHostBroker  sidtype unrestricted, member of Hyper-V Administrators, SeChangeNotifyPrivilege only; its config names the inner VM. The name is fixed: the Broker derives
#                     the per-service SID it trusts (config / journal folder owner) from it (ServicePathGuard.ServiceName), so another name would be refused with exit 73.
#   AlberaLabHvCP     the Control Plane: sidtype restricted, no group, SeChangeNotifyPrivilege only. The Broker's config names its SID; the Broker service lets it query the service status.
#   AlberaLabHvOther  "somebody else": same shape as the Broker (unrestricted, member of Hyper-V Administrators), but not the Control Plane.
$BdBrokerSvc = 'AlberaHostBroker'
$BdCpSvc = 'AlberaLabHvCP'
$BdOtherSvc = 'AlberaLabHvOther'
$BdCells = @(@{ Svc = $BdBrokerSvc }, @{ Svc = $BdCpSvc }, @{ Svc = $BdOtherSvc })
$BdPipe = 'ALBERA_HvLab_HostBroker'
$BdDesktopPipe = "${BdPipe}_desktop"   # the Broker's rule (ServiceConfig.DesktopPipeName): the claim pipe's name + "_desktop"
$BdComputerId = 'lab-room'
# The claim path (receipt v2, task.start): what the Broker's config pins and what the lab's receipts carry. The helper is the Control Plane's real pipe client; it sends the claims.
$BdProjectId = 'lab-project'
$BdAuthorityKid = 'lab-hv-authority-1'
$BdLeaseId = 'lab-hv-lease-1'
$BdPolicyVersion = 'lab-hv-policy-1'
$BdHelper = "$LabRoot\bin\helper\albera-windows-broker-pipe-client.exe"
$BdTask = 'Lab check: tap the Shift key once'
$BdOp1 = 'lab-bd-act-1'    # the operationId of the first task.start claim: the desktopSessionId of the first lease (generation 1)
$BdOp2 = 'lab-bd-act-2'    # the second claim replaces that lease (generation 2)
$BdShiftVk = 16
$BdRevokeWaitMs = 15000    # how long the first act session is given to be ended by the second claim (the Broker does it at once; the idle close is 60 s)
$BhSquatSeconds = 40       # how long the squatter waits for a connection (it ends as soon as one comes and goes)
$BhBrokerSha = ''          # SHA-256 of the Broker file (lower case): what the helper is told the image behind the desktop pipe must hash to; set in Invoke-BrokerDesktopLab
$BhWrongSha = ''           # a well-formed SHA-256 that is not the Broker's (the helper file's own)
$BdTitles = [ordered]@{
  bd_prereq_broker  = 'The Broker build was copied into the guest'
  bd_broker_ready   = 'Broker service (unrestricted, member of Hyper-V Administrators, SeChangeNotifyPrivilege only, config names the inner VM) starts and reports RUNNING'
  bd_broker_token   = 'Broker token: unrestricted (no restricting SIDs), Hyper-V Administrators enabled, exactly SeChangeNotifyPrivilege'
  bd_cp_token       = 'Control Plane token: restricted, not in Hyper-V Administrators, exactly SeChangeNotifyPrivilege'
  bd_other_token    = 'Other caller token: unrestricted, member of Hyper-V Administrators, exactly SeChangeNotifyPrivilege (so a refusal is not for want of the group)'
  bd_desktop_pipe   = 'Desktop pipe exists: owner = Broker SID, DACL = Broker + one Control Plane ACE 0x00120083, served from the Broker process in session 0'
  bd_cp_view_open   = 'Control Plane: a view session on the inner VM is accepted'
  bd_cp_view_capture = 'Control Plane: a capture over that session returns a valid PNG (signature, IHDR of the asked size, IEND) of the inner VM screen'
  bd_cp_act_before_claim_refused = 'Control Plane: an act open that names operation lab-bd-act-1 and generation 1 is refused with the fixed denied reply while no task.start claim has been recorded'
  bd_other_refused  = 'A caller that is not the Control Plane (member of Hyper-V Administrators) gets no session: refused by the pipe DACL or by the peer check'
  bd_cp_task_start_claim = 'Control Plane: fence, a receipt v2 (guest.command / task.start) signed with the lab key and sent by the helper is claimed (state UNKNOWN, action task.start, not a replay)'
  bd_cp_act_open    = 'Control Plane: after that claim the same act open (operation lab-bd-act-1, generation 1) is accepted'
  bd_cp_act_input   = 'Control Plane: in that act session a keyboard input (tap Shift) is accepted'
  bd_cp_act_input_mouse = 'MEASURED: the same session, mouse input (move, button 1 down, button 1 up). The inner VM has no OS: the synthetic mouse call is expected to fail (32768) and the Broker to answer denied'
  bd_cp_act_wrong_generation_refused = 'Control Plane: an act open for operation lab-bd-act-1 with generation 2 (the lease is generation 1) is refused with the fixed denied reply'
  bd_cp_act_revoked_by_new_claim = 'Control Plane: a second task.start claim (operation lab-bd-act-2) is recorded while a first act session is open, and the Broker ends that session with the fixed denied frame'
  bd_broker_restart_drops_lease = 'Control Plane: the second lease (lab-bd-act-2, generation 2) opens an act session; after the Broker service is restarted the same open is refused (the lease lived in memory)'
  bh_cp_image_readable = 'MEASURED: the Control Plane may open the Broker service process (PROCESS_QUERY_LIMITED_INFORMATION) and read its image; the hash it computes is the SHA-256 of the Broker file. The helper needs this to pin imageSha256'
  bh_view_open      = 'Control Plane, REAL helper in desktop mode (service identity, imageSha256 = the Broker file): a view session on the inner VM is accepted'
  bh_view_capture   = 'Control Plane, REAL helper (service identity + imageSha256): a 640x480 capture over that session returns a valid PNG (signature, IHDR of the asked size, IEND)'
  bh_view_service_only = 'CONTROL: the same helper without imageSha256 (service identity only): a view open and a capture are accepted. Tells a failed image pin apart from a failed helper path'
  bh_wrong_image_refused = 'Control Plane, REAL helper: an imageSha256 that is not the hash of the Broker file is refused with server_identity_mismatch before anything is sent (server_identity_unavailable = the image could not be read, so the comparison was never reached: BLOCKED)'
  bh_act_open       = 'Control Plane, REAL helper (service identity + imageSha256): after the task.start claim an act session for operation lab-bd-act-1, generation 1 is accepted'
  bh_act_input      = 'Control Plane, REAL helper (service identity + imageSha256): in that act session a keyboard input (tap Shift) is accepted'
  bh_act_service_only = 'CONTROL: the same act open and keyboard input through the helper without imageSha256 (service identity only)'
  bh_squatter_broker_stopped = 'Broker stopped, another identity (AlberaLabHvOther) holds the desktop pipe name: the helper (service identity + imageSha256) ends with a server_identity code (the SCM has no running Broker) and the squatter receives 0 bytes'
  bh_squatter_owner_mismatch = 'Same state: the helper (given the old PID and the owner SID of the Broker) connects to the squatter and ends with server_identity_mismatch; the squatter receives 0 bytes'
}
$Ops = @(
  @{ Id = 'wmi_connect';               Kind = 'gate';      Title = 'WMI connect to root\virtualization\v2' },
  @{ Id = 'vm_lookup';                 Kind = 'gate';      Title = 'Get Msvm_ComputerSystem by Name (VM GUID)' },
  @{ Id = 'mgmt_read';                 Kind = 'reference'; Title = 'Read Msvm_VirtualSystemManagementService (read only, not a Broker call)' },
  @{ Id = 'thumbnail';                 Kind = 'sensitive'; Title = 'GetVirtualSystemThumbnailImage 640x480' },
  @{ Id = 'keyboard_typekey';          Kind = 'sensitive'; Title = 'Msvm_Keyboard.TypeKey once' },
  @{ Id = 'mouse_setabsoluteposition'; Kind = 'sensitive'; Title = 'Msvm_SyntheticMouse.SetAbsolutePosition once' },
  @{ Id = 'adapter_capture';           Kind = 'sensitive'; Title = 'Broker adapter (HyperVDesktop + ComWmiConnection) Capture 640x480: a PNG with a valid signature and IHDR' },
  @{ Id = 'adapter_input';             Kind = 'sensitive'; Title = 'Broker adapter Input: move, tap Shift, mouse button 1 down and up' }
)

# ------------------------------------------------------------------ pure logic (the unit test loads these functions by themselves, no VM involved)

# Non-ASCII text from WMI error messages must not reach the evidence file (it is written as ASCII), and machine SIDs stay out of it.
function Get-AsciiText([string]$Text) {
  $t = $Text -replace 'S-1-5-21(-[0-9]+)+', 'S-1-5-21-<redacted>'
  $t -replace '[^\x20-\x7E]', '?'
}

# One probe line -> what happened: allowed | denied | not_visible | error | missing.
# A skipped line takes the outcome of the check it waited for (a refused connect refuses everything after it).
# An adapter line (adapter_capture, adapter_input) carries only a DesktopReason word: the Broker's adapter hides why it failed. When it says it could not reach or
# drive the VM, the cause is read from the raw check(s) of the same operation, in the same process and token: refused there = refused here. Anything else is 'error'.
function Get-HvOutcome($Line, $ById) {
  if ($null -eq $Line) { return 'missing' }
  if ($Line.skipped) {
    $cause = $ById[[string]$Line.because]
    if ($null -eq $cause -or $cause.skipped) { return 'missing' }
    return (Get-HvOutcome $cause $ById)
  }
  if ($Line.ok -eq $true) { return 'allowed' }
  $partners = @{ adapter_capture = @('thumbnail'); adapter_input = @('keyboard_typekey', 'mouse_setabsoluteposition') }
  if ($partners.ContainsKey([string]$Line.id)) {
    if ([string]$Line.reason -notin @('desktop_unavailable', 'capture_failed', 'input_failed')) { return 'error' }
    $raw = @($partners[[string]$Line.id] | ForEach-Object { Get-HvOutcome $ById[$_] $ById })
    if ($raw -contains 'denied') { return 'denied' }
    if ($raw -contains 'not_visible') { return 'not_visible' }
    return 'error'
  }
  # The probe's own wording for "the WMI object did not show up for this caller" (management_service_not_found, realized_settings_not_found, VirtualSystemType
  # lookups): a caller that may not see the object is refused in effect.
  if ([string]$Line.exception -eq 'InvalidOperationException' -and [string]$Line.message -like '*_not_found') { return 'not_visible' }
  $hr = [string]$Line.hresult
  if ($hr -in @('0x80041003', '0x80070005', '0x80010005')) { return 'denied' }       # WBEM_E_ACCESS_DENIED, E_ACCESSDENIED, RPC_E_ACCESS_DENIED
  if ($null -ne $Line.returnValue -and [int64]$Line.returnValue -eq 32769) { return 'denied' }   # Hyper-V method ReturnValue 32769 = Access Denied
  if ($hr -eq '0x80041002') { return 'not_visible' }                                  # WBEM_E_NOT_FOUND: the object is hidden from this caller
  return 'error'
}

# Outcome -> verdict. Only an observation that does not answer the question (error, no output) is BLOCKED; the open question (restricted member) is MEASURED.
function Get-HvVerdict([bool]$Member, [string]$SidType, [string]$Kind, [string]$Outcome) {
  if ($Outcome -eq 'missing') { return 'BLOCKED' }
  if ($Kind -eq 'reference') { return 'MEASURED' }
  if ($SidType -eq 'restricted' -and $Member) { return 'MEASURED' }
  if (-not $Member) {
    if ($Kind -eq 'gate') { return 'MEASURED' }
    if ($Outcome -in @('denied', 'not_visible')) { return 'PASS' }
    if ($Outcome -eq 'allowed') { return 'FAIL' }
    return 'BLOCKED'
  }
  if ($Outcome -eq 'allowed') { return 'PASS' }
  if ($Outcome -in @('denied', 'not_visible')) { return 'FAIL' }
  return 'BLOCKED'
}

# Is the live service token the shape this cell claims? If not, the cell's results mean nothing. $Token is TokenReport JSON (the shim writes it).
function Test-HvTokenShape($Token, [string]$ExpectedSid, [bool]$Member, [string]$SidType) {
  $hvAdmins = 'S-1-5-32-578'
  $evidence = @(); $ok = $true
  if ($null -eq $Token) { return @{ Ok = $false; Evidence = @('no token report was written') } }
  $user = [string]$Token.user.sid
  if ($user -ne $ExpectedSid) { $ok = $false }
  $evidence += "token user $(Get-AsciiText $user) (service SID $(Get-AsciiText $ExpectedSid))"
  $group = @($Token.groups | Where-Object { $_.sid -eq $hvAdmins }) | Select-Object -First 1
  $effective = ($null -ne $group) -and (@($group.attributes) -contains 'enabled') -and (@($group.attributes) -notcontains 'deny_only')
  if ($effective -ne $Member) { $ok = $false }
  $evidence += "$hvAdmins in token: $(if ($null -eq $group) { 'absent' } else { (@($group.attributes) -join '+') }) (expected $(if ($Member) { 'enabled' } else { 'absent' }))"
  $restricting = @($Token.restrictedSids | Where-Object { $_ }).Count
  if (($restricting -gt 0) -ne ($SidType -eq 'restricted')) { $ok = $false }
  $evidence += "restricting SIDs: $restricting, hasRestrictions=$($Token.hasRestrictions) (expected $SidType)"
  $privileges = @($Token.privileges | ForEach-Object { $_.name })
  if ($privileges.Count -ne 1 -or $privileges[0] -ne 'SeChangeNotifyPrivilege') { $ok = $false }
  $evidence += "privileges: $($privileges -join ', ')"
  @{ Ok = $ok; Evidence = $evidence }
}

# ---- the Broker desktop section (pure logic, loaded by the unit test on its own)

# The desktop client's lines (albera-lab-service-shim.exe desktop ...) by step id: connect, open, capture, ...
function ConvertTo-BdById($Objects) {
  $byId = @{}
  foreach ($o in @($Objects)) { if ($o.id) { $byId[[string]$o.id] = $o } }
  $byId
}

# One step -> what happened: allowed | refused_pipe | refused_reply | bad_result | still_open | error | missing.
#   refused_pipe   the pipe's DACL refused the open (access denied), so no byte was sent
#   refused_reply  the Broker answered with the fixed denied frame (the only refusal it ever sends)
#   bad_result     it answered, but with something that is not what the step asks for (a capture that is not a PNG of the asked size)
#   still_open     an `end` step: the Broker did not end the session in the time given (reply `timeout`)
#   error          anything else: no connection, the server was not the expected one, the connection ended without a frame, an unknown reply
# A step that did not run takes the outcome of the step it waited for.
function Get-BdOutcome($ById, [string]$Step) {
  $connect = $ById['connect']
  if ($null -eq $connect) { return 'missing' }
  if ($connect.ok -ne $true) { if ([string]$connect.result -eq 'denied') { return 'refused_pipe' } else { return 'error' } }
  $line = $ById[$Step]
  if ($null -eq $line) { return 'missing' }
  if ($line.skipped) {
    if ([string]$line.because -eq 'connect') { return 'error' }
    return (Get-BdOutcome $ById ([string]$line.because))
  }
  if ($line.ok -eq $true) { return 'allowed' }
  switch ([string]$line.reply) {
    'denied' { return 'refused_reply' }
    'png_invalid' { return 'bad_result' }
    'timeout' { return 'still_open' }
    default { return 'error' }
  }
}

# Outcome -> verdict. $Expect is 'allowed', 'refused' or 'measured'; $Refusals are the refusal outcomes this check can judge (an act open must reach the Broker, so a refused pipe does not
# count). 'measured' records whatever happened (MEASURED) and only a step that gave no answer is BLOCKED.
# What could not be measured (error, no output, a refusal at a layer this check does not cover) is BLOCKED, never a quiet PASS.
function Get-BdVerdict([string]$Expect, [string[]]$Refusals, [string]$Outcome) {
  if ($Outcome -in @('missing', 'error')) { return 'BLOCKED' }
  if ($Expect -eq 'measured') { return 'MEASURED' }
  if ($Expect -eq 'allowed') { if ($Outcome -eq 'allowed') { return 'PASS' } else { return 'FAIL' } }
  if ($Outcome -in $Refusals) { return 'PASS' }
  if ($Outcome -in @('allowed', 'bad_result', 'still_open')) { return 'FAIL' }
  return 'BLOCKED'
}

# The helper's last line for a fence or a claim -> the same outcome words as a desktop step. A claim that was recorded but is not what was sent (another action, a replay, another state)
# is bad_result; the Broker's fixed denied reply is refused_reply; every other helper code (it could not reach or identify the Broker, a timeout, an invalid reply) is error.
function Get-BdClaimOutcome($Line, [string]$ExpectedAction) {
  if ($null -eq $Line) { return 'missing' }
  if ($Line.ok -eq $true) {
    if ([string]$Line.action -eq $ExpectedAction -and [string]$Line.state -eq 'UNKNOWN' -and $Line.replayed -ne $true) { return 'allowed' }
    return 'bad_result'
  }
  if ([string]$Line.code -eq 'denied') { return 'refused_reply' }
  return 'error'
}

# The job that holds an act session open, makes a second claim from the same process, and waits for the Broker to end the session (steps open, claim, end).
# PASS only when the session was open, the claim went through and the Broker then ended the session with its denied frame; a session that is still open after the claim is a FAIL.
# What did not get that far (no session, the claim refused) is BLOCKED: it says nothing about revocation.
function Get-BdRevokeVerdict($ById) {
  if ((Get-BdOutcome $ById 'open') -ne 'allowed') { return 'BLOCKED' }
  $claim = $ById['claim']
  if ($null -eq $claim -or $claim.ok -ne $true) { return 'BLOCKED' }
  Get-BdVerdict 'refused' @('refused_reply') (Get-BdOutcome $ById 'end')
}

# The lease must be accepted before the restart (else the refusal after it proves nothing) and refused after it.
function Get-BdRestartVerdict([string]$Before, [string]$After) {
  if ($Before -ne 'allowed') { return 'BLOCKED' }
  Get-BdVerdict 'refused' @('refused_reply') $After
}

# ---- the helper-driven checks (bh_*): the shim's `desktop-helper` lines by step id are: helper, open, capture, input, ..., close (DesktopHelperClient.cs)

# One step -> what happened: allowed | refused_reply | refused_pipe | identity_mismatch | identity_unavailable | bad_result | error | missing. The helper's own words:
#   refused_reply         the Broker answered with the fixed denied frame (the helper relays only that)
#   refused_pipe          the pipe's DACL refused the helper's open (access_denied): no byte was sent
#   identity_mismatch     the helper connected and the server was not the expected one (owner, PID, session or image): server_identity_mismatch, before it wrote anything
#   identity_unavailable  the helper could not establish who the server is (no running service, an image it may not read, ...): server_identity_unavailable, before it wrote anything
#   bad_result            it answered, but with a capture that is not a valid PNG of the asked size
#   error                 anything else: the helper was not started (helper_unavailable), no pipe (broker_unavailable), a timeout or transport_error, no frame, an unknown reply
# A step that did not run takes the outcome of the step it waited for.
function Get-BhOutcome($ById, [string]$Step) {
  $helper = $ById['helper']
  if ($null -eq $helper) { return 'missing' }
  if ($helper.ok -ne $true) { return 'error' }
  $line = $ById[$Step]
  if ($null -eq $line) { return 'missing' }
  if ($line.skipped) { return (Get-BhOutcome $ById ([string]$line.because)) }
  if ($line.ok -eq $true) { return 'allowed' }
  switch ([string]$line.reply) {
    'denied' { return 'refused_reply' }
    'access_denied' { return 'refused_pipe' }
    'server_identity_mismatch' { return 'identity_mismatch' }
    'server_identity_unavailable' { return 'identity_unavailable' }
    'png_invalid' { return 'bad_result' }
    default { return 'error' }
  }
}

# The openproc probe's line (what the Control Plane may do to the Broker process) -> readable | denied | wrong_hash | error | missing.
function Get-BhImageOutcome($Line, [string]$ExpectedSha) {
  if ($null -eq $Line) { return 'missing' }
  $opened = [string]$Line.openProcess.PROCESS_QUERY_LIMITED_INFORMATION
  if ($opened -eq 'denied') { return 'denied' }
  if ($opened -ne 'opened') { return 'error' }
  if ([string]$Line.imageSha256 -eq $ExpectedSha) { return 'readable' }
  'wrong_hash'
}

# Either answer is a result (it decides whether the Control Plane can pin the Broker image at all); a hash that differs from the file is a defect; no answer is BLOCKED.
function Get-BhImageVerdict([string]$Outcome) {
  if ($Outcome -in @('readable', 'denied')) { return 'MEASURED' }
  if ($Outcome -eq 'wrong_hash') { return 'FAIL' }
  'BLOCKED'
}

# A squatter holds the desktop pipe name while the Broker is stopped. $Ready / $Done are the squat probe's lines (state ready, state done). PASS only when the squatter was really in place, the
# helper ended with one of $Refusals, and not one byte reached the squatter. $MustConnect: the refusal is only meaningful if the helper did reach the squatter (the owner check). A byte at the squatter
# is a FAIL whatever the helper said; a squatter that was never in place, or a missing line, is BLOCKED.
function Get-BhSquatVerdict([string]$Outcome, [string[]]$Refusals, $Ready, $Done, [bool]$MustConnect) {
  if ($null -eq $Ready) { return 'BLOCKED' }
  if ($null -ne $Done -and [int64]$Done.bytesReceived -gt 0) { return 'FAIL' }
  if ($Outcome -in @('missing', 'error')) { return 'BLOCKED' }
  if ($Outcome -in @('allowed', 'bad_result')) { return 'FAIL' }
  if ($Outcome -notin $Refusals) { return 'BLOCKED' }
  if ($MustConnect -and ($null -eq $Done -or $Done.connected -ne $true)) { return 'BLOCKED' }
  'PASS'
}

# The desktop pipe, seen by the Control Plane (pipe-open with 0x00120083): owner, DACL, server process and session. $Open is the shim's pipe-open line.
function Test-BdPipeAcl($Open, [string]$BrokerSid, [string]$CpSid, $BrokerPid) {
  if ($null -eq $Open -or [string]$Open.result -ne 'opened') { return @{ Ok = $false; Evidence = @("open as Control Plane: $(if ($null -eq $Open) { 'no line' } else { $Open.result })") } }
  $sddl = [string]$Open.sddl
  $aces = @([regex]::Matches($sddl, '\(([A-Z]+);[^;]*;([^;]+);[^;]*;[^;]*;([^)]+)\)') | ForEach-Object { @{ Type = $_.Groups[1].Value; Mask = $_.Groups[2].Value; Sid = $_.Groups[3].Value } })
  $cpAces = @($aces | Where-Object { $_.Sid -eq $CpSid })
  $brokerAces = @($aces | Where-Object { $_.Sid -eq $BrokerSid })
  $strangers = @($aces | Where-Object { $_.Sid -notin @($BrokerSid, $CpSid, 'SY', 'S-1-5-18') })   # SYSTEM may be written as SY
  $ok = ([string]$Open.owner -eq $BrokerSid) -and $cpAces.Count -eq 1 -and $cpAces[0].Type -eq 'A' -and $cpAces[0].Mask -ieq '0x120083' -and $brokerAces.Count -ge 1 -and $strangers.Count -eq 0 `
    -and ([string]$Open.serverSession -eq '0') -and ([string]$Open.serverPid -eq [string]$BrokerPid)
  @{ Ok = $ok; Evidence = @("open as Control Plane: $($Open.result)", "owner=$($Open.owner) (Broker SID $BrokerSid)", "sddl=$sddl", "serverPid=$($Open.serverPid) servicePid=$BrokerPid serverSession=$($Open.serverSession) (expected 0)") }
}

# A throwaway Approval Authority for this run: an ECDSA P-256 key made here, in the guest. Kid and Spki (base64 SubjectPublicKeyInfo) are what the Broker's `authorityKeys` pins; Signer signs
# the lab's receipts (SHA-256, IEEE P1363 r||s, which is what the Broker verifies). The private half is an ephemeral CNG key: it is never exported, never written to disk and ends with this
# process. No key material travels from the host.
function New-LabAuthority([string]$Kid) {
  $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256)
  $blob = $key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)   # BCRYPT_ECCKEY_BLOB: magic (4), cbKey (4), X (32), Y (32)
  if ($blob.Length -ne 72) { throw "unexpected public key blob length $($blob.Length)" }
  $prefix = [byte[]](0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04)
  $spki = New-Object byte[] ($prefix.Length + 64)
  [Array]::Copy($prefix, 0, $spki, 0, $prefix.Length)
  [Array]::Copy($blob, 8, $spki, $prefix.Length, 64)
  $signer = New-Object System.Security.Cryptography.ECDsaCng($key)
  $signer.HashAlgorithm = [System.Security.Cryptography.CngAlgorithm]::Sha256
  @{ Kid = $Kid; Spki = [Convert]::ToBase64String($spki); Signer = $signer }
}

# ---- receipt v2 for task.start (the lab's own copy of what the contract defines; the unit test checks it against src/runtime/broker-contract)

function Write-LabBigEndian([System.IO.Stream]$Out, [uint64]$Value, [int]$Count) {
  for ($i = $Count - 1; $i -ge 0; $i--) { $Out.WriteByte([byte](($Value -shr (8 * $i)) -band 0xFF)) }
}
function Write-LabDigestString([System.IO.Stream]$Out, [string]$Text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $Out.WriteByte(0x53)
  Write-LabBigEndian $Out ([uint64]$bytes.Length) 4
  $Out.Write($bytes, 0, $bytes.Length)
}
# enc(map) of the action digest: 0x4D, the entry count, then key and value for each key in ordinal order. Only string values and nested maps (the shape of a task.start DTO).
function Write-LabDigestMap([System.IO.Stream]$Out, [System.Collections.IDictionary]$Map) {
  $Out.WriteByte(0x4D)
  Write-LabBigEndian $Out ([uint64]$Map.Count) 4
  [string[]]$names = @($Map.Keys)
  [Array]::Sort($names, [System.StringComparer]::Ordinal)
  foreach ($name in $names) {
    Write-LabDigestString $Out $name
    $value = $Map[$name]
    if ($value -is [string]) { Write-LabDigestString $Out $value }
    elseif ($value -is [System.Collections.IDictionary]) { Write-LabDigestMap $Out $value }
    else { throw "unsupported value for $name in an action DTO" }
  }
}
# "sha256:" + hex of SHA-256 over "albera.action-digest.v1" 0x00 enc(purpose) enc(dto) (src/runtime/broker-contract/action-digest.mjs).
function Get-LabActionDigest([string]$Purpose, [System.Collections.IDictionary]$Dto) {
  $stream = New-Object System.IO.MemoryStream
  $domain = [System.Text.Encoding]::UTF8.GetBytes('albera.action-digest.v1')
  $stream.Write($domain, 0, $domain.Length)
  $stream.WriteByte(0)
  Write-LabDigestString $stream $Purpose
  Write-LabDigestMap $stream $Dto
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash($stream.ToArray())
  $sha.Dispose()
  'sha256:' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
}
# 128 random bits as unpadded base64url (22 characters, the canonical form the receipt grammar wants).
function New-LabNonce {
  $bytes = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
# One signed receipt v2 for a guest.command / task.start claim that names the challenge in $Fence (the helper's fence reply), together with the action DTO (base64 of its UTF-8 JSON) the Broker's
# three-key claim carries. Returns receipt, signature and action, all base64. $Authority is New-LabAuthority's result; iat is now and the receipt lives 240 s (the contract's bound is 300).
function New-LabTaskStartReceipt($Authority, $Fence, [string]$OperationId, [string]$ProjectId, [string]$ComputerId, [string]$Task, [string]$LeaseId, [string]$PolicyVersion) {
  $digest = Get-LabActionDigest 'guest.command' @{ action = 'task.start'; projectId = $ProjectId; computerId = $ComputerId; args = @{ task = $Task } }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $fields = [ordered]@{
    v = 2; kid = $Authority.Kid; issuer = 'albera-approval-authority'; audience = 'albera-host-broker'; purpose = 'guest.command'
    approvalId = [guid]::NewGuid().ToString(); receiptId = [guid]::NewGuid().ToString(); nonce = (New-LabNonce)
    operationId = $OperationId; idempotencyKey = "idem-$OperationId"; action = 'task.start'; actionDigest = $digest
    projectId = $ProjectId; computerId = $ComputerId; leaseId = $LeaseId
    leaseGeneration = [int64]$Fence.leaseGeneration; brokerEpoch = [int64]$Fence.brokerEpoch; brokerChallenge = [string]$Fence.brokerChallenge
    policyVersion = $PolicyVersion; approverKeyId = 'lab-approver-1'; iat = [int64]$now; exp = [int64]($now + 240)
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $fields -Compress))
  $dto = [ordered]@{ action = 'task.start'; projectId = $ProjectId; computerId = $ComputerId; args = [ordered]@{ task = $Task } }
  $action = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $dto -Compress))
  @{ receipt = [Convert]::ToBase64String($bytes); signature = [Convert]::ToBase64String($Authority.Signer.SignData($bytes)); action = [Convert]::ToBase64String($action) }
}

# ------------------------------------------------------------------ guest helpers
function Emit-Json($Value) { Write-Output (ConvertTo-Json -InputObject $Value -Compress -Depth 8) }
function Get-Svc([string]$Name) { Get-CimInstance Win32_Service -Filter "Name='$Name'" }
function Get-Sid([string]$Account) { (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$What) {
  $end = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $end) { if (& $Condition) { return }; Start-Sleep -Milliseconds 500 }
  throw "timeout waiting for $What"
}
function Get-HvAdminsGroupName { (Get-LocalGroup -SID $HvAdminsSid).Name }
function Stop-LabService([string]$Name) {
  $svc = Get-Svc $Name
  if ($svc -and $svc.State -ne 'Stopped') {
    & sc.exe stop $Name | Out-Null
    Wait-Until { (Get-Svc $Name).State -eq 'Stopped' } 30 "$Name stopped"
  }
}
# Removes everything one cell created: membership first (the name stops resolving once the service is gone), then the service. Never throws.
function Remove-HvCell($Cell) {
  $svc = $Cell.Svc
  try { & net.exe localgroup (Get-HvAdminsGroupName) "NT SERVICE\$svc" /delete 2>$null | Out-Null } catch { }
  try { if (Get-Svc $svc) { Stop-LabService $svc; & sc.exe delete $svc | Out-Null } } catch { }
}
function Remove-InnerVm {
  try {
    if (Get-VM -Name $InnerVmName -ErrorAction SilentlyContinue) {
      Stop-VM -Name $InnerVmName -TurnOff -Force -ErrorAction SilentlyContinue
      Remove-VM -Name $InnerVmName -Force
    }
  } catch { }
}

if ($Phase -eq 'install-feature') {
  $feature = Get-WindowsFeature -Name Hyper-V
  if ($feature.Installed) { Emit-Json @{ alreadyInstalled = $true; success = $true; restartNeeded = $false }; return }
  $r = Install-WindowsFeature -Name Hyper-V -IncludeManagementTools
  Emit-Json @{ alreadyInstalled = $false; success = [bool]$r.Success; restartNeeded = ([string]$r.RestartNeeded -ne 'No'); exitCode = [string]$r.ExitCode }
  return
}

if ($Phase -eq 'cleanup') {
  foreach ($c in ($Cells + $BdCells)) { Remove-HvCell $c }
  Remove-InnerVm
  Emit-Json @{ cleaned = $true; servicesLeft = @(($Cells + $BdCells) | Where-Object { Get-Svc $_.Svc } | ForEach-Object { $_.Svc }) }
  return
}

# ------------------------------------------------------------------ run phase
$checks = New-Object System.Collections.ArrayList
$cellReports = New-Object System.Collections.ArrayList
$matrix = [ordered]@{}
foreach ($op in $Ops) { $matrix[$op.Id] = [ordered]@{ op = $op.Id } }

function Add-Check([string]$Id, [string]$Title, [string]$Status, [string]$Observed, [string[]]$Evidence) {
  [void]$checks.Add([ordered]@{ id = $Id; title = $Title; status = $Status; observed = $Observed; evidence = @($Evidence | ForEach-Object { Get-AsciiText $_ }) })
  Write-Host ("  {0,-8} {1}  {2}" -f $Status, $Id, $Observed)
}
function Read-ResultLines([string]$Path) { if (Test-Path -LiteralPath $Path) { @(Get-Content -LiteralPath $Path) } else { @() } }
function Grant-Path([string]$Path, [string]$Sid, [string]$Rights) {
  & icacls.exe $Path /grant "*${Sid}:(OI)(CI)$Rights" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}
function New-LockedDir([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}
function Compact-Line($Line) {
  if ($null -eq $Line) { return 'no line' }
  $parts = @()
  foreach ($name in @('ok', 'skipped', 'because', 'reason', 'pngCheck', 'exception', 'hresult', 'returnValue', 'bytes', 'steps', 'enabledState', 'enumeration', 'message')) {
    if ($null -ne $Line.$name) { $parts += "$name=$($Line.$name)" }
  }
  $parts -join ' '
}

# Creates one lab service under its virtual account and gives it what it needs to start: the service SID type, SeChangeNotifyPrivilege as its only privilege (the ADR-002
# shape), optionally membership of Hyper-V Administrators, read access to bin and config, and its own results folder. Returns the service SID.
function Install-HvService([string]$svc, [string]$binPath, [string]$sidType, [bool]$member) {
  & sc.exe create $svc binPath= $binPath obj= "NT SERVICE\$svc" start= demand type= own | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc create $svc failed ($LASTEXITCODE)" }
  & sc.exe sidtype $svc $sidType | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc sidtype $svc failed ($LASTEXITCODE)" }
  & sc.exe privs $svc SeChangeNotifyPrivilege | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc privs $svc failed ($LASTEXITCODE)" }
  $sid = Get-Sid "NT SERVICE\$svc"
  if ($member) {
    & net.exe localgroup (Get-HvAdminsGroupName) "NT SERVICE\$svc" /add 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "adding $svc to Hyper-V Administrators failed ($LASTEXITCODE)" }
  }
  Grant-Path "$LabRoot\bin" $sid 'RX'
  Grant-Path "$LabRoot\config" $sid 'RX'
  New-LockedDir "$LabRoot\results\$svc"
  Grant-Path "$LabRoot\results\$svc" $sid 'M'
  & icacls.exe $LabRoot /grant "*${sid}:RX" | Out-Null
  $sid
}

# One identity: create the service, run the probe through it, judge, remove it again.
function Invoke-HvCell($Cell, [string]$VmId) {
  $svc = $Cell.Svc; $code = $Cell.Code
  $report = [ordered]@{ code = $code; service = $svc; sidtype = $Cell.SidType; member = $Cell.Member }
  $resultFile = "$LabRoot\results\$svc\probe.txt"; $tokenFile = "$LabRoot\results\$svc\probe.token.json"
  try {
    $sid = Install-HvService $svc "$Shim service $LabRoot\config\$svc.json" $Cell.SidType $Cell.Member
    $config = @{ mode = 'child'; program = $Shim; args = @('hyperv', $VmId); resultFile = $resultFile; tokenFile = $tokenFile; timeoutSeconds = 100 }
    (ConvertTo-Json -InputObject $config -Depth 4) | Set-Content -Encoding Ascii -Path "$LabRoot\config\$svc.json"
    & sc.exe start $svc | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc start $svc failed ($LASTEXITCODE)" }
    Wait-Until { (Get-Svc $svc).State -eq 'Stopped' } 150 "$svc finished"
    $exit = Get-Svc $svc
    $report.serviceExit = "win32=$($exit.ExitCode) specific=$($exit.ServiceSpecificExitCode)"
  }
  catch { $report.setupError = Get-AsciiText $_.Exception.Message }
  finally { Remove-HvCell $Cell }

  $lines = @(Read-ResultLines $resultFile)
  $byId = @{}
  foreach ($text in ($lines | Where-Object { $_ -like '{*' })) {
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if ($obj.probe -eq 'hyperv' -and $obj.id) { $byId[[string]$obj.id] = $obj }
  }
  $stderr = @($lines | Where-Object { $_ -like '[[]stderr]*' } | Select-Object -First 3 | ForEach-Object { Get-AsciiText $_ })
  $token = $null
  if (Test-Path -LiteralPath $tokenFile) { try { $token = Get-Content -Raw -LiteralPath $tokenFile | ConvertFrom-Json } catch { } }
  $shape = Test-HvTokenShape $token $sid $Cell.Member $Cell.SidType
  $report.tokenOk = $shape.Ok
  $report.probeLines = @($byId.Values | ForEach-Object { Compact-Line $_ })
  if ($stderr.Count -gt 0) { $report.stderr = $stderr }
  $shapeNote = "$($Cell.SidType), $(if ($Cell.Member) { 'member of' } else { 'not in' }) Hyper-V Administrators"
  Add-Check "hv_${code}_token" "Service token has the shape of this cell ($shapeNote)" $(if ($shape.Ok) { 'PASS' } else { 'BLOCKED' }) $(if ($shape.Ok) { 'as_intended' } else { 'shape_mismatch' }) $shape.Evidence

  foreach ($op in $Ops) {
    $line = $byId[$op.Id]
    $outcome = Get-HvOutcome $line $byId
    $verdict = Get-HvVerdict $Cell.Member $Cell.SidType $op.Kind $outcome
    $note = @("$($op.Id): $(Compact-Line $line)")
    if ($report.setupError) { $note += "setup error: $($report.setupError)" }
    if ($line -and $line.skipped) { $note += "not attempted: $($line.because) came first" }
    if (-not $shape.Ok) { $verdict = 'BLOCKED'; $note += "token shape is not the cell's (hv_${code}_token), so this result is not used" }
    if ($verdict -eq 'BLOCKED' -and $stderr.Count -gt 0) { $note += $stderr }
    $matrix[$op.Id][$code] = $(if ($shape.Ok) { $outcome } else { 'blocked' })
    Add-Check "hv_${code}_$($op.Id)" "$shapeNote : $($op.Title)" $verdict $outcome $note
  }
  [void]$cellReports.Add($report)
}

# ---- the Broker desktop section

$bdOutcomes = [ordered]@{}

# Runs `albera-lab-service-shim.exe <probeArgs>` as the installed lab service $svc (child mode, so the probe has the service's own token) and waits for it to finish.
# Returns the probe's JSON lines (only those whose "probe" is $probe), the token report the shim wrote, stderr, and an error text when the service could not be run.
function Invoke-HvShimJob([string]$svc, [string]$tag, [string[]]$probeArgs, [string]$probe) {
  Invoke-HvJob $svc $tag $Shim $probeArgs $null $probe
}

# The same for any program: `$program $jobArgs` with the text of $stdinFile on its stdin (when given). With no $probe every JSON object the program printed is returned
# (the Control Plane helper prints one reply line without a "probe" member).
function Invoke-HvJob([string]$svc, [string]$tag, [string]$program, [string[]]$jobArgs, [string]$stdinFile, [string]$probe) {
  Complete-HvJob (Start-HvJob $svc $tag $program $jobArgs $stdinFile) $probe
}

# Writes the job's config and starts the service; does not wait. Error is set when it could not be started.
function Start-HvJob([string]$svc, [string]$tag, [string]$program, [string[]]$jobArgs, [string]$stdinFile) {
  $resultFile = "$LabRoot\results\$svc\$tag.txt"; $tokenFile = "$LabRoot\results\$svc\$tag.token.json"
  $job = @{ Svc = $svc; ResultFile = $resultFile; TokenFile = $tokenFile; Objects = @(); Token = $null; Stderr = @(); Error = $null }
  try {
    $config = @{ mode = 'child'; program = $program; args = $jobArgs; resultFile = $resultFile; tokenFile = $tokenFile; timeoutSeconds = 100 }
    if ($stdinFile) { $config.stdinFile = $stdinFile }
    (ConvertTo-Json -InputObject $config -Depth 4) | Set-Content -Encoding Ascii -Path "$LabRoot\config\$svc.json"
    & sc.exe start $svc | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc start $svc failed ($LASTEXITCODE)" }
  }
  catch { $job.Error = Get-AsciiText $_.Exception.Message }
  $job
}

# Waits for the job's service to finish, then reads what it wrote (the lines whose "probe" is $probe, the token report, stderr).
function Complete-HvJob($job, [string]$probe) {
  try { if (-not $job.Error) { Wait-Until { (Get-Svc $job.Svc).State -eq 'Stopped' } 150 "$($job.Svc) finished" } }
  catch { $job.Error = Get-AsciiText $_.Exception.Message }
  $lines = @(Read-ResultLines $job.ResultFile)
  foreach ($text in ($lines | Where-Object { $_ -like '{*' })) {
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if (-not $probe -or $obj.probe -eq $probe) { $job.Objects += $obj }
  }
  $job.Stderr = @($lines | Where-Object { $_ -like '[[]stderr]*' } | Select-Object -First 3 | ForEach-Object { Get-AsciiText $_ })
  if (Test-Path -LiteralPath $job.TokenFile) { try { $job.Token = Get-Content -Raw -LiteralPath $job.TokenFile | ConvertFrom-Json } catch { } }
  $job
}

# A token-shape check. A wrong shape is the finding for the Broker and the Control Plane (the shapes the owner decided), so it is a FAIL; for the stand-in caller it only
# means the lab built the wrong thing, so the result is BLOCKED. A token that could not be read is BLOCKED.
function Add-BdTokenCheck([string]$Id, $Token, [string]$ExpectedSid, [bool]$Member, [string]$SidType, [string]$OnMismatch, [string]$Source) {
  if ($null -eq $Token -or $Token.result) {
    Add-Check $Id $BdTitles[$Id] 'BLOCKED' 'unreadable' @("token not available ($Source)$(if ($Token.result) { ': ' + $Token.result })")
    return @{ Ok = $false }
  }
  $shape = Test-HvTokenShape $Token $ExpectedSid $Member $SidType
  Add-Check $Id $BdTitles[$Id] $(if ($shape.Ok) { 'PASS' } else { $OnMismatch }) $(if ($shape.Ok) { 'as_intended' } else { 'shape_mismatch' }) (@($shape.Evidence) + "token read from: $Source")
  $shape
}

# One step of a desktop-client job -> one check.
function Add-BdStepCheck([string]$Id, $Job, [string]$Step, [string]$Expect, [string[]]$Refusals, $Shape, [string[]]$Note = @()) {
  $outcome = Get-BdOutcome (ConvertTo-BdById $Job.Objects) $Step
  Add-BdJobCheck $Id $Job $outcome (Get-BdVerdict $Expect $Refusals $outcome) $Shape $Note
}

# One check from a job: its lines are the evidence. A caller whose token is not the shape the check names makes the result BLOCKED, whatever it was.
function Add-BdJobCheck([string]$Id, $Job, [string]$Outcome, [string]$Verdict, $Shape, [string[]]$Note = @()) {
  $notes = @($Job.Objects | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 3 }) + $Note
  if ($Job.Error) { $notes += "job error: $($Job.Error)" }
  if (-not $Shape.Ok) { $Verdict = 'BLOCKED'; $notes += 'the caller token is not the shape this check names (see its _token check), so this result is not used' }
  if ($Verdict -eq 'BLOCKED' -and $Job.Stderr.Count -gt 0) { $notes += $Job.Stderr }
  $bdOutcomes[$Id] = $Outcome
  Add-Check $Id $BdTitles[$Id] $Verdict $Outcome $notes
}

function Add-BdBlocked([string[]]$Ids, [string]$Why) {
  foreach ($id in $Ids) { Add-Check $id $BdTitles[$id] 'BLOCKED' 'not_measured' @($Why) }
}

# The Broker's service configuration (ServiceConfig.cs): the pinned authority key (the throwaway one, New-LabAuthority), the Control Plane's SID, and the inner VM as the one computer.
# The lease id and policy version are what every lab receipt carries too. Generation 1 is the claim pipe's fence value (the lab's first lease), not the desktop lease's generation.
function Write-BdBrokerConfig([string]$Path, [string]$Database, [string]$ControlPlaneSid, [string]$VmId, $Authority) {
  $config = [ordered]@{
    pipeName = $BdPipe; database = $Database
    authorityKeys = @([ordered]@{ kid = $Authority.Kid; spki = $Authority.Spki })
    controlPlaneSid = $ControlPlaneSid; generation = 1; leaseId = $BdLeaseId; policyVersion = $BdPolicyVersion
    computers = @([ordered]@{ computerId = $BdComputerId; vmId = $VmId.ToLowerInvariant() })
  }
  (ConvertTo-Json -InputObject $config -Compress -Depth 5) | Set-Content -Encoding Ascii -Path $Path
}

# What the Control Plane helper reads on stdin: a fence request, or a claim ({receipt, signature, action}), and who it must find at the end of the claim pipe (the Broker service, by name).
# Written to the config folder, which every lab service may read. Returns the path.
function New-BdHelperInput([string]$Name, $Claim) {
  $body = [ordered]@{ pipeName = $BdPipe }
  if ($null -eq $Claim) { $body.fence = $BdComputerId } else { $body.receipt = $Claim.receipt; $body.signature = $Claim.signature; $body.action = $Claim.action }
  $body.timeoutMs = 10000
  $body.expect = [ordered]@{ serviceName = $BdBrokerSvc }
  $path = "$LabRoot\config\$Name.stdin.json"
  (ConvertTo-Json -InputObject $body -Compress -Depth 4) | Set-Content -Encoding Ascii -Path $path
  $path
}

# fence -> sign -> (the claim is sent by the caller). Returns the fence job, the fence reply line and the signed claim; Claim is null when the fence gave no usable reply.
function New-BdSignedClaim([string]$Name, [string]$OperationId, $Authority) {
  $fenceJob = Invoke-HvJob $BdCpSvc "$Name-fence" $BdHelper @() (New-BdHelperInput "$BdCpSvc.$Name-fence" $null) $null
  $fence = $fenceJob.Objects | Select-Object -Last 1
  $claim = $null
  if ($null -ne $fence -and $fence.ok -eq $true) { $claim = New-LabTaskStartReceipt $Authority $fence $OperationId $BdProjectId $BdComputerId $BdTask $BdLeaseId $BdPolicyVersion }
  @{ Job = $fenceJob; Fence = $fence; Claim = $claim }
}

# The Broker service restarted: stop, start, wait for RUNNING (it reports RUNNING only after its pipes exist). Returns the new PID, or 0 when it did not come back.
function Restart-BdBroker {
  Stop-LabService $BdBrokerSvc
  & sc.exe start $BdBrokerSvc | Out-Null
  try { Wait-Until { (Get-Svc $BdBrokerSvc).State -in @('Running', 'Stopped') } 40 "$BdBrokerSvc running or stopped" } catch { }
  $svcInfo = Get-Svc $BdBrokerSvc
  if ($svcInfo.State -eq 'Running') { [int]$svcInfo.ProcessId } else { 0 }
}

# ---- the helper-driven checks (bh_*). The Control Plane service runs the shim's `desktop-helper` probe, which starts the REAL pipe client helper in desktop mode and plays the Node client.

# One helper session as the Control Plane service. $Identity is service:<name> or pid:<pid>:<ownerSid>; $Image is expect.imageSha256 ('' = not pinned); $Steps are open / capture / input steps.
function Invoke-BhJob([string]$Tag, [string]$Identity, [string[]]$Steps, [string]$Image) {
  $probeArgs = @('desktop-helper', $BdHelper, $BdDesktopPipe, $Identity) + $Steps
  if ($Image) { $probeArgs += "image=$Image" }
  Invoke-HvShimJob $BdCpSvc $Tag $probeArgs 'desktop-helper'
}

# One step of a helper session -> one check (the helper's words, see Get-BhOutcome).
function Add-BhStepCheck([string]$Id, $Job, [string]$Step, [string]$Expect, [string[]]$Refusals, $Shape, [string[]]$Note = @()) {
  $outcome = Get-BhOutcome (ConvertTo-BdById $Job.Objects) $Step
  Add-BdJobCheck $Id $Job $outcome (Get-BdVerdict $Expect $Refusals $outcome) $Shape $Note
}

# View: what the Control Plane may know about the Broker image, then the production identity (service name + image pin), the same without the pin, and a wrong pin. Needs no lease.
function Invoke-BhViewChecks($CpShape, [int]$BrokerPid) {
  $ids = @('bh_cp_image_readable', 'bh_view_open', 'bh_view_capture', 'bh_view_service_only', 'bh_wrong_image_refused')
  if (-not (Test-Path -LiteralPath $BdHelper)) { Add-BdBlocked $ids "not found: $BdHelper (lab-vm.ps1 copies the pipe client publish folder)"; return }
  $identity = "service:$BdBrokerSvc"
  $open = "open:view:$BdComputerId"

  $procJob = Invoke-HvShimJob $BdCpSvc 'bh-openproc' @('openproc', "$BrokerPid") 'openproc'
  $imageOutcome = Get-BhImageOutcome ($procJob.Objects | Select-Object -Last 1) $BhBrokerSha
  Add-BdJobCheck 'bh_cp_image_readable' $procJob $imageOutcome (Get-BhImageVerdict $imageOutcome) $CpShape @("Broker file sha256: $BhBrokerSha", 'denied = the helper cannot pin the Broker image from this identity: bh_view_open and bh_view_capture then end with server_identity_unavailable')

  $pinned = Invoke-BhJob 'bh-view' $identity @($open, 'capture:640x480') $BhBrokerSha
  Add-BhStepCheck 'bh_view_open' $pinned 'open' 'allowed' @() $CpShape @("image pin: the Broker file, sha256 $BhBrokerSha")
  Add-BhStepCheck 'bh_view_capture' $pinned 'capture' 'allowed' @() $CpShape

  $plain = Invoke-BhJob 'bh-view-plain' $identity @($open, 'capture:640x480') ''
  Add-BhStepCheck 'bh_view_service_only' $plain 'capture' 'allowed' @() $CpShape

  $wrong = Invoke-BhJob 'bh-view-wrong' $identity @($open) $BhWrongSha
  Add-BhStepCheck 'bh_wrong_image_refused' $wrong 'open' 'refused' @('identity_mismatch') $CpShape @("image pin: the helper file, sha256 $BhWrongSha (a real hash that is not the Broker one)")
}

# Act through the helper on the lease the first claim made (operation lab-bd-act-1, generation 1): the open and a keyboard input with the image pin, the same without it. Called with the lease in place.
function Invoke-BhActChecks($CpShape) {
  $identity = "service:$BdBrokerSvc"
  $steps = @("open:act:${BdComputerId}:${BdOp1}:1", "input:tap=$BdShiftVk")
  $pinned = Invoke-BhJob 'bh-act' $identity $steps $BhBrokerSha
  Add-BhStepCheck 'bh_act_open' $pinned 'open' 'allowed' @() $CpShape
  Add-BhStepCheck 'bh_act_input' $pinned 'input' 'allowed' @() $CpShape
  $plain = Invoke-BhJob 'bh-act-plain' $identity $steps ''
  Add-BhStepCheck 'bh_act_service_only' $plain 'input' 'allowed' @() $CpShape
}

# Squatters. The Broker is stopped and another identity (the Other service, the squat probe) takes the desktop pipe name. First the production identity (the SCM has no running Broker, so the helper
# cannot even say who it expects), then the Broker's old PID and owner SID (the helper connects, finds another owner, and must end before it writes). The squatter counts the bytes it receives.
function Invoke-BhSquatChecks($CpShape, [string]$BrokerSid, [int]$BrokerPid) {
  $ids = @('bh_squatter_broker_stopped', 'bh_squatter_owner_mismatch')
  if (-not (Test-Path -LiteralPath $BdHelper)) { Add-BdBlocked $ids "not found: $BdHelper (lab-vm.ps1 copies the pipe client publish folder)"; return }
  Stop-LabService $BdBrokerSvc
  $squat = Start-HvJob $BdOtherSvc 'bh-squat' $Shim @('squat', $BdDesktopPipe, "$BhSquatSeconds") $null
  try { Wait-Until { @(Read-ResultLines $squat.ResultFile | Where-Object { $_ -like '*"state":"ready"*' -or $_ -like '*"state":"pipe_exists"*' }).Count -gt 0 } 20 'the squatter to be ready' } catch { }
  $byService = Invoke-BhJob 'bh-squat-service' "service:$BdBrokerSvc" @("open:view:$BdComputerId") $BhBrokerSha
  $byOwner = Invoke-BhJob 'bh-squat-owner' "pid:${BrokerPid}:${BrokerSid}" @("open:view:$BdComputerId") ''
  $squat = Complete-HvJob $squat 'squat'
  $ready = $squat.Objects | Where-Object { $_.state -eq 'ready' } | Select-Object -First 1
  $done = $squat.Objects | Where-Object { $_.state -eq 'done' } | Select-Object -Last 1
  $note = @("squatter lines: $(@($squat.Objects | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 3 }) -join ' ')")
  if ($squat.Error) { $note += "squatter job error: $($squat.Error)" }
  $outcome = Get-BhOutcome (ConvertTo-BdById $byService.Objects) 'open'
  Add-BdJobCheck 'bh_squatter_broker_stopped' $byService $outcome (Get-BhSquatVerdict $outcome @('identity_unavailable', 'identity_mismatch') $ready $done $false) $CpShape $note
  $outcome = Get-BhOutcome (ConvertTo-BdById $byOwner.Objects) 'open'
  Add-BdJobCheck 'bh_squatter_owner_mismatch' $byOwner $outcome (Get-BhSquatVerdict $outcome @('identity_mismatch') $ready $done $true) $CpShape $note
}

# The real Broker as AlberaHostBroker, a Control Plane caller and another caller; then the Broker desktop pipe is exercised as each. Called with the inner VM running.
function Invoke-BrokerDesktopLab([string]$VmId) {
  $brokerExe = "$LabRoot\bin\broker\albera-windows-broker.exe"
  if (-not (Test-Path -LiteralPath $brokerExe)) {
    Add-Check 'bd_prereq_broker' $BdTitles.bd_prereq_broker 'BLOCKED' 'missing' @("not found: $brokerExe (lab-vm.ps1 copies the Broker publish folder)")
    Add-BdBlocked @($BdTitles.Keys | Where-Object { $_ -ne 'bd_prereq_broker' }) 'the Broker build is not in the guest'
    return
  }
  Add-Check 'bd_prereq_broker' $BdTitles.bd_prereq_broker 'PASS' 'present' @("found: $brokerExe")
  foreach ($c in $BdCells) { if (Get-Svc $c.Svc) { throw "service $($c.Svc) already exists; refusing to touch it" } }

  # The callers first: the Broker's config names the Control Plane's SID.
  $cpSid = Install-HvService $BdCpSvc "$Shim service $LabRoot\config\$BdCpSvc.json" 'restricted' $false
  $otherSid = Install-HvService $BdOtherSvc "$Shim service $LabRoot\config\$BdOtherSvc.json" 'unrestricted' $true
  $brokerConfig = "$LabRoot\config\$BdBrokerSvc.service.json"
  $brokerSid = Install-HvService $BdBrokerSvc "$brokerExe service $brokerConfig" 'unrestricted' $true
  # As in the service lab: the Control Plane may ask the SCM about the Broker service (status only), which is how it finds the server PID.
  & sc.exe sdset $BdBrokerSvc "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;${cpSid})" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc sdset $BdBrokerSvc failed ($LASTEXITCODE)" }
  New-LockedDir "$LabRoot\data"
  Grant-Path "$LabRoot\data" $brokerSid 'RX'
  New-LockedDir "$LabRoot\data\broker"
  Grant-Path "$LabRoot\data\broker" $brokerSid 'M'
  New-Item -ItemType Directory -Force -Path "$LabRoot\evidence" | Out-Null
  $authority = New-LabAuthority $BdAuthorityKid   # the key the Broker pins; its private half signs the lab's receipts
  Write-BdBrokerConfig $brokerConfig "$LabRoot\data\broker\journal.sqlite" $cpSid $VmId $authority

  & sc.exe start $BdBrokerSvc | Out-Null
  $startCode = $LASTEXITCODE
  try { Wait-Until { (Get-Svc $BdBrokerSvc).State -in @('Running', 'Stopped') } 40 "$BdBrokerSvc running or stopped" } catch { }   # a start that is refused (exit 73, 76...) ends Stopped
  $svcInfo = Get-Svc $BdBrokerSvc
  $brokerPid = [int]$svcInfo.ProcessId
  $running = ($svcInfo.State -eq 'Running') -and $brokerPid -gt 0
  Add-Check 'bd_broker_ready' $BdTitles.bd_broker_ready $(if ($running) { 'PASS' } else { 'FAIL' }) $(if ($running) { 'running' } else { 'not_running' }) @(
    "sc start exit=$startCode state=$($svcInfo.State) pid=$brokerPid win32=$($svcInfo.ExitCode) specific=$($svcInfo.ServiceSpecificExitCode)",
    "binPath: $($svcInfo.PathName)", "sidtype: $(((& sc.exe qsidtype $BdBrokerSvc) -join ' ' -replace '\s+', ' ').Trim())", "privileges: $(((& sc.exe qprivs $BdBrokerSvc) -join ' ' -replace '\s+', ' ').Trim())",
    "config computers: $BdComputerId -> $VmId", "desktop pipe name: $BdDesktopPipe")
  if (-not $running) {
    Add-BdBlocked @($BdTitles.Keys | Where-Object { $_ -notin @('bd_prereq_broker', 'bd_broker_ready') }) 'the Broker service is not running (bd_broker_ready)'
    return
  }

  # The Broker's token, read off the running service process as the interactive Administrator (the way check a_token of the service lab does it).
  $brokerToken = (& $Shim token-of "$brokerPid") | ConvertFrom-Json
  [void](Add-BdTokenCheck 'bd_broker_token' $brokerToken $brokerSid $true 'unrestricted' 'FAIL' 'token-of <Broker pid> as Administrator')

  # Control Plane: the pipe's shape, a view session with a capture, an act open before any claim.
  $pipeJob = Invoke-HvShimJob $BdCpSvc 'pipe' @('pipe-open', $BdDesktopPipe, '00120083') 'pipe-open'
  $cpShape = Add-BdTokenCheck 'bd_cp_token' $pipeJob.Token $cpSid $false 'restricted' 'FAIL' 'the shim report of the Control Plane service'
  $openLine = $pipeJob.Objects | Select-Object -Last 1   # null when the probe printed nothing
  $acl = Test-BdPipeAcl $openLine $brokerSid $cpSid $brokerPid
  $aclNote = @($acl.Evidence); if ($pipeJob.Error) { $aclNote += "job error: $($pipeJob.Error)" }
  Add-Check 'bd_desktop_pipe' $BdTitles.bd_desktop_pipe $(if ($acl.Ok) { 'PASS' } else { 'FAIL' }) $(if ($acl.Ok) { 'as_intended' } else { 'unexpected' }) $aclNote

  $pngPath = "$LabRoot\results\$BdCpSvc\view.png"
  $viewJob = Invoke-HvShimJob $BdCpSvc 'view' @('desktop', $BdDesktopPipe, "service:$BdBrokerSvc", "open:view:$BdComputerId", 'capture:640x480', "save=$pngPath") 'desktop'
  Add-BdStepCheck 'bd_cp_view_open' $viewJob 'open' 'allowed' @() $cpShape
  Add-BdStepCheck 'bd_cp_view_capture' $viewJob 'capture' 'allowed' @() $cpShape
  if (Test-Path -LiteralPath $pngPath) { Copy-Item -LiteralPath $pngPath -Destination "$LabRoot\evidence\bd-view-capture.png" -Force }

  # The open names the operation and generation the first claim will make; nothing has been claimed yet, so the Broker has no lease to match it with.
  $beforeJob = Invoke-HvShimJob $BdCpSvc 'act-before' @('desktop', $BdDesktopPipe, "service:$BdBrokerSvc", "open:act:${BdComputerId}:${BdOp1}:1") 'desktop'
  Add-BdStepCheck 'bd_cp_act_before_claim_refused' $beforeJob 'open' 'refused' @('refused_reply') $cpShape

  # Another caller with the Broker's own shape: it may not query the service, so it is told the server's PID and owner (what the Control Plane would learn from the SCM).
  $otherJob = Invoke-HvShimJob $BdOtherSvc 'view' @('desktop', $BdDesktopPipe, "pid:${brokerPid}:${brokerSid}", "open:view:$BdComputerId", 'capture:640x480') 'desktop'
  $otherShape = Add-BdTokenCheck 'bd_other_token' $otherJob.Token $otherSid $true 'unrestricted' 'BLOCKED' 'the shim report of the other caller service'
  Add-BdStepCheck 'bd_other_refused' $otherJob 'open' 'refused' @('refused_pipe', 'refused_reply') $otherShape

  $script:BhBrokerSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $brokerExe).Hash.ToLowerInvariant()
  $script:BhWrongSha = if (Test-Path -LiteralPath $BdHelper) { (Get-FileHash -Algorithm SHA256 -LiteralPath $BdHelper).Hash.ToLowerInvariant() } else { '' }
  Invoke-BhViewChecks $cpShape $brokerPid
  Invoke-BdActChecks $authority $cpShape
  Invoke-BhSquatChecks $cpShape $brokerSid $brokerPid   # last: it stops the Broker
}

# The checks that need a lease. Their only source is a task.start claim recorded by the Broker, so the lab makes one the way the Control Plane does: fence, a receipt v2 signed with the lab
# authority, the helper sends it. Without a recorded claim every check below is BLOCKED (an act open would fail for want of a lease, which says nothing about the lease).
function Invoke-BdActChecks($Authority, $CpShape) {
  $dependents = @($BdTitles.Keys | Where-Object { $_ -in @('bd_cp_act_open', 'bd_cp_act_input', 'bd_cp_act_input_mouse', 'bd_cp_act_wrong_generation_refused', 'bd_cp_act_revoked_by_new_claim', 'bd_broker_restart_drops_lease', 'bh_act_open', 'bh_act_input', 'bh_act_service_only') })
  if (-not (Test-Path -LiteralPath $BdHelper)) {
    Add-Check 'bd_cp_task_start_claim' $BdTitles.bd_cp_task_start_claim 'BLOCKED' 'missing' @("not found: $BdHelper (lab-vm.ps1 copies the pipe client publish folder)")
    Add-BdBlocked $dependents 'no lease: the helper that sends the claim is not in the guest'
    return
  }
  if (-not (Add-BdClaimCheck 'claim1' $BdOp1 $Authority $CpShape)) {
    Add-BdBlocked $dependents 'no lease: the task.start claim was not recorded (bd_cp_task_start_claim)'
    return
  }

  # One act session on the first lease: the open, a keyboard input, then mouse input. A refused input ends the session, so the mouse request comes last.
  $actJob = Invoke-HvShimJob $BdCpSvc 'act-input' @('desktop', $BdDesktopPipe, "service:$BdBrokerSvc", "open:act:${BdComputerId}:${BdOp1}:1", "input:tap=$BdShiftVk", 'input:move=100,100+down=1+up=1') 'desktop'
  Add-BdStepCheck 'bd_cp_act_open' $actJob 'open' 'allowed' @() $CpShape
  Add-BdStepCheck 'bd_cp_act_input' $actJob 'input' 'allowed' @() $CpShape
  if ((Get-BdOutcome (ConvertTo-BdById $actJob.Objects) 'input') -eq 'allowed') {
    Add-BdStepCheck 'bd_cp_act_input_mouse' $actJob 'input_2' 'measured' @() $CpShape @('known on an inner VM without an OS: refused_reply, because the synthetic mouse call fails with 32768 (a Broker log would say input_failed)')
  }
  else { Add-BdBlocked @('bd_cp_act_input_mouse') 'the keyboard input did not go through (bd_cp_act_input), so the mouse request was not sent' }

  $wrongJob = Invoke-HvShimJob $BdCpSvc 'act-wrong-generation' @('desktop', $BdDesktopPipe, "service:$BdBrokerSvc", "open:act:${BdComputerId}:${BdOp1}:2") 'desktop'
  Add-BdStepCheck 'bd_cp_act_wrong_generation_refused' $wrongJob 'open' 'refused' @('refused_reply') $CpShape
  Invoke-BhActChecks $CpShape   # through the real helper, on the same lease (the next call replaces it)
  Invoke-BdLeaseEndChecks $Authority $CpShape
}

# fence -> sign -> send as the Control Plane, judged as bd_cp_task_start_claim. Returns $true when the Broker recorded the claim.
function Add-BdClaimCheck([string]$Name, [string]$OperationId, $Authority, $Shape) {
  $signed = New-BdSignedClaim $Name $OperationId $Authority
  if ($null -eq $signed.Claim) {
    Add-Check 'bd_cp_task_start_claim' $BdTitles.bd_cp_task_start_claim 'BLOCKED' 'fence_failed' @("fence reply: $(ConvertTo-Json -InputObject $signed.Fence -Compress -Depth 3)", "job error: $($signed.Job.Error)")
    return $false
  }
  $claimJob = Invoke-HvJob $BdCpSvc $Name $BdHelper @() (New-BdHelperInput "$BdCpSvc.$Name" $signed.Claim) $null
  $outcome = Get-BdClaimOutcome ($claimJob.Objects | Select-Object -Last 1) 'task.start'
  Add-BdJobCheck 'bd_cp_task_start_claim' $claimJob $outcome (Get-BdVerdict 'allowed' @() $outcome) $Shape @("fence reply: $(ConvertTo-Json -InputObject $signed.Fence -Compress -Depth 3)")
  return ($outcome -eq 'allowed')
}

# The two ways a lease ends: a newer claim (the first act session is held open while the second claim is made from the same process), and a Broker restart (the lease is in memory only).
function Invoke-BdLeaseEndChecks($Authority, $CpShape) {
  $ids = @('bd_cp_act_revoked_by_new_claim', 'bd_broker_restart_drops_lease')
  $second = New-BdSignedClaim 'claim2' $BdOp2 $Authority
  if ($null -eq $second.Claim) { Add-BdBlocked $ids "the fence for the second claim failed: $(ConvertTo-Json -InputObject $second.Fence -Compress -Depth 3)"; return }
  $claimInput = New-BdHelperInput "$BdCpSvc.claim2" $second.Claim
  $revokeJob = Invoke-HvShimJob $BdCpSvc 'act-revoke' @('desktop', $BdDesktopPipe, "service:$BdBrokerSvc", "open:act:${BdComputerId}:${BdOp1}:1", 'claim', "end:$BdRevokeWaitMs", "claim-exe=$BdHelper", "claim-stdin=$claimInput") 'desktop'
  $byId = ConvertTo-BdById $revokeJob.Objects
  Add-BdJobCheck 'bd_cp_act_revoked_by_new_claim' $revokeJob (Get-BdOutcome $byId 'end') (Get-BdRevokeVerdict $byId) $CpShape

  # The second lease must be good before the restart, or the refusal after it proves nothing.
  $reopen = @('desktop', $BdDesktopPipe, "service:$BdBrokerSvc", "open:act:${BdComputerId}:${BdOp2}:2")
  $beforeJob = Invoke-HvShimJob $BdCpSvc 'lease2-before' $reopen 'desktop'
  $before = Get-BdOutcome (ConvertTo-BdById $beforeJob.Objects) 'open'
  $restartedPid = Restart-BdBroker
  if ($restartedPid -eq 0) {
    Add-Check 'bd_broker_restart_drops_lease' $BdTitles.bd_broker_restart_drops_lease 'BLOCKED' 'not_running_after_restart' @("state: $((Get-Svc $BdBrokerSvc).State)", "open before the restart: $before")
    return
  }
  $afterJob = Invoke-HvShimJob $BdCpSvc 'lease2-after' $reopen 'desktop'
  $after = Get-BdOutcome (ConvertTo-BdById $afterJob.Objects) 'open'
  Add-BdJobCheck 'bd_broker_restart_drops_lease' $afterJob $after (Get-BdRestartVerdict $before $after) $CpShape @("open before the restart: $before", "Broker pid after the restart: $restartedPid")
}

$innerId = $null
$innerState = $null
try {
  # ---- preconditions: the role works, and an inner VM that is running
  $feature = Get-WindowsFeature -Name Hyper-V
  $hypervisor = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
  $vmmsOk = $true
  try { Wait-Until { (Get-Service vmms -ErrorAction SilentlyContinue).Status -eq 'Running' } 180 'vmms running' } catch { $vmmsOk = $false }
  $moduleOk = [bool](Get-Command New-VM -ErrorAction SilentlyContinue)
  $roleOk = $feature.Installed -and $hypervisor -and $vmmsOk -and $moduleOk
  Add-Check 'hv_prereq_role' 'Hyper-V role works in the lab guest (installed, hypervisor present, vmms running, Hyper-V module)' $(if ($roleOk) { 'PASS' } else { 'BLOCKED' }) $(if ($roleOk) { 'ready' } else { 'not_ready' }) @(
    "installed=$($feature.Installed) hypervisorPresent=$hypervisor vmms=$vmmsOk module=$moduleOk")

  if ($roleOk) {
    # Gen2, 512 MB fixed, no disk, no network: it stops at the UEFI screen and stays Running, which is all a capture and an input need.
    Remove-InnerVm
    $null = New-VM -Name $InnerVmName -Generation 2 -MemoryStartupBytes 512MB -NoVHD -Path "$LabRoot\innervm"
    Set-VM -Name $InnerVmName -CheckpointType Disabled -Notes 'ALBERA lab inner VM (disposable)'
    Set-VMMemory -VMName $InnerVmName -DynamicMemoryEnabled $false
    Get-VMNetworkAdapter -VMName $InnerVmName | Remove-VMNetworkAdapter
    Start-VM -Name $InnerVmName
    Wait-Until { (Get-VM -Name $InnerVmName).State -eq 'Running' } 90 'inner VM running'
    Start-Sleep -Seconds 20   # let the firmware draw its first screen
    $inner = Get-VM -Name $InnerVmName
    $innerId = [string]$inner.Id; $innerState = [string]$inner.State
    Add-Check 'hv_prereq_inner_vm' 'Inner VM (Gen2, 512 MB fixed, no disk, no network) is Running' $(if ($innerState -eq 'Running') { 'PASS' } else { 'BLOCKED' }) $innerState @(
      "state=$innerState memoryStartupMB=$([int]($inner.MemoryStartup / 1MB)) generation=$($inner.Generation)")

    if ($innerState -eq 'Running') {
      New-LockedDir "$LabRoot\config"
      New-LockedDir "$LabRoot\results"
      foreach ($c in $Cells) { if (Get-Svc $c.Svc) { throw "service $($c.Svc) already exists; refusing to touch it" } }
      foreach ($c in $Cells) { Invoke-HvCell $c $innerId }
      # After the four measurements: the real Broker as a service, and its desktop pipe.
      try { Invoke-BrokerDesktopLab $innerId }
      catch { Add-Check 'bd_script_error' 'The Broker desktop section of the lab script failed' 'BLOCKED' 'exception' @(Get-AsciiText $_.Exception.Message) }
    }
  }
}
catch {
  Add-Check 'hv_script_error' 'The lab script itself failed' 'BLOCKED' 'exception' @($_.Exception.Message)
}
finally {
  Remove-InnerVm
  foreach ($c in ($Cells + $BdCells)) { Remove-HvCell $c }
}

$os = Get-CimInstance Win32_OperatingSystem
$ubr = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').UBR
$summary = [ordered]@{}
foreach ($s in @('PASS', 'FAIL', 'BLOCKED', 'MEASURED')) { $summary[$s] = @($checks | Where-Object { $_.status -eq $s }).Count }
$results = [ordered]@{
  lab = 'hyperv-rights'
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  guest = [ordered]@{ caption = $os.Caption; build = "$($os.BuildNumber).$ubr" }
  innerVm = [ordered]@{ generation = 2; memoryMB = 512; state = $innerState }
  summary = $summary
  matrix = @($matrix.Values | ForEach-Object { [pscustomobject]$_ })
  cells = $cellReports.ToArray()
  brokerDesktop = [ordered]@{ pipe = $BdDesktopPipe; computerId = $BdComputerId; outcomes = [pscustomobject]$bdOutcomes }
  checks = $checks.ToArray()
}
New-Item -ItemType Directory -Force -Path "$LabRoot\evidence" | Out-Null
ConvertTo-Json -InputObject $results -Depth 8 | Set-Content -Encoding Ascii -Path "$LabRoot\evidence\hyperv-results.json"
Write-Output (ConvertTo-Json -InputObject $results -Depth 8 -Compress)
