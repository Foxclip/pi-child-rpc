# Dual reads-mode ACL switcher for the dedicated-user pi-supervisor variant.
#
#   allow mode: NO agent ACEs outside the project - the account gets the
#               default (base) Windows ACLs: on this machine E: grants
#               Authenticated Users Modify, so outside reads AND writes
#               follow the defaults (the account behaves like any normal
#               logged-on user out there; C:\Users\Suburban & co. stay
#               protected by their own profile DACLs).
#   deny  mode: full (OI)(CI)F deny on every outside dir - the account can
#               neither read nor write anything outside the project subtree.
#
# Why allow mode has no "deny writes" ACEs: probed on this Windows build,
# every tested write-mask deny (full (OI)(CI)F and (OI)(CI)
# (D,DC,WD,AD,WA,WO)) blocks LIST/READ as well, so "allow reads, deny
# writes" is not expressible with icacls deny masks here. Hence allow =
# plain default ACLs, deny = sealed.
#
# Both modes: explicit (OI)(CI) Modify grant on the project (agent's writable
# zone); the zone root (parent of the project) gets a PARTIAL deny
# (D,DC,WD,AD,WA,WO) so the agent can still list/traverse it but cannot
# create/rename/delete entries in it.
#
# IMPORTANT: uses icacls, NOT .NET ACE classes. On this machine the PS 5.1
# host cannot resolve the AccessControlTypes enum (System.Accessibility not
# loaded) so every FileSystemAccessRule constructor fails. icacls is the
# proven path (the original tier-1 setup used it successfully).
#
# Scope parameterization (so it can be tested on a synthetic tree):
#   -Zone       sealed zone root (default: parent of -Project)
#   -OuterDir   farther root whose Suburban-owned children are also sealed
#               (default: parent of -Zone); -NoOuter skips it (test mode)
#
# Reversible: icacls /remove:agent on the same paths (and the tier-1
# rollback .bat covers the original setup).
#
# Pure ASCII. Run as Suburban.
param(
  [string]$User = 'agent',
  [string]$Project = 'E:\Projects\Box2D_Editor',
  [string]$Zone = '',
  [string]$OuterDir = '',
  [switch]$NoOuter,
  [ValidateSet('allow','deny')][string]$Reads = 'deny',
  [switch]$Apply
)
$ErrorActionPreference = 'Continue'
$me = (whoami).Trim()
$q = [char]34

if (-not (Test-Path $Project)) { Write-Output "ERROR: project not found: $Project"; exit 2 }
if ($Zone -eq '') { $Zone = (Split-Path $Project -Parent) }
if ($NoOuter) { $OuterDir = '' }
elseif ($OuterDir -eq '') { $OuterDir = (Split-Path $Zone -Parent) }

function IcaclsRun([string[]]$args_, [string]$tag) {
  $cmd = 'icacls'
  foreach ($a in $args_) { $cmd = $cmd + ' ' + $q + $a + $q }
  $out = & cmd.exe /c ($cmd + ' 2>&1 & echo EXITCODE=%ERRORLEVEL%')
  $exitLine = ($out | Where-Object { $_ -match '^EXITCODE=\d+$' } | Select-Object -First 1)
  $code = 999
  if ($exitLine) { $code = [int]($exitLine -replace '^EXITCODE=', '') }
  $txt = (($out | Where-Object { $_ -notmatch '^EXITCODE=' }) -join ' | ').Trim()
  if ($code -ne 0) { throw ("icacls exit " + $code + " : " + $txt) }
}

function OwnerOf([string]$path) {
  try { return [string][System.IO.Directory]::GetAccessControl($path).Owner } catch { return $null }
}

# CRITICAL syntax: the SID is a SEPARATE argument - '/remove:g <user>'.
# The one-arg form '/remove:g:agent' is an INVALID parameter, but icacls still
# exits 0 (silent no-op) - verified empirically, which is what silently
# doubled stale ACEs earlier.
function AgentAces([string]$p) {
  return (& icacls $p 2>&1 | Select-String -Pattern ($User + ':') | Out-String)
}
function CleanPath([string]$p, [string]$tag) {
  IcaclsRun @($p, '/remove:g', $User) ($tag + "-allow") | Out-Null
  IcaclsRun @($p, '/remove:d', $User) ($tag + "-deny") | Out-Null
  $left = (AgentAces $p).Trim()
  if ($left -ne '') { throw ("agent ACEs remain on " + $p + ": " + $left) }
}

# --- enumerate scope -------------------------------------------------------
$siblings = @(Get-ChildItem -Force $Zone -ErrorAction SilentlyContinue | Where-Object { $_.FullName -ine $Project })
$outer = @()
if ($OuterDir -and (Test-Path $OuterDir)) {
  foreach ($e in (Get-ChildItem -Force $OuterDir -ErrorAction SilentlyContinue)) {
    if ($e.FullName -ieq $Zone) { continue }
    $o = OwnerOf $e.FullName
    if ($null -eq $o) { continue }          # owner unreadable -> admin tier, skip
    if ($o -ne $me) { continue }           # not ours -> admin tier, skip
    $outer += $e.FullName
  }
}
$grantAce = $User + ':(OI)(CI)M'
$fullDeny = $User + ':(OI)(CI)F'
$partDeny = $User + ':(D,DC,WD,AD,WA,WO)'

Write-Output ("user: " + $User + "   mode: " + $Reads + "   apply: " + $Apply)
Write-Output ("project: " + $Project)
Write-Output ("zone: " + $Zone + "  (siblings=" + $siblings.Count + ")")
Write-Output ("outer: " + $OuterDir + "  (suburban-owned children=" + $outer.Count + ")")

$script:okCount = 0; $script:failCount = 0
function Step([string]$label, [scriptblock]$sb) {
  if (-not $Apply) { Write-Output ("[dry] " + $label); return }
  try { & $sb; Write-Output ("[ok]   " + $label); $script:okCount++ }
  catch { $script:failCount++; Write-Output ("[FAIL] " + $label + " -- " + $_.Exception.Message) }
}

# --- apply ---
# Both modes: clean every agent ACE in the scope, then:
#   - project: (OI)(CI)M grant (the writable zone)
#   - zone root: PARTIAL deny (D,DC,WD,AD,WA,WO) without OI/CI - the agent
#     can still list/traverse it (needed to reach the project) but cannot
#     create/rename/delete entries in it
# Mode difference (outside ACEs):
#   deny  mode: full (OI)(CI)F deny on every outside dir - reads AND writes
#     blocked (verified: list/create/read/delete all DENIED)
#   allow mode: NO outside ACEs - access falls back to the base ACLs
#     (default Windows permissions; on this machine E: grants Authenticated
#     Users Modify, so outside reads AND writes both follow the defaults)
# NOTE: a write-only deny mask like (OI)(CI)(D,DC,WD,AD,WA,WO) was tested
# and REJECTED for allow mode: on this Windows build any such deny on a
# directory blocks LIST/READ as well (probed: list/create/read/delete all
# DENIED), so "allow reads, deny writes" is not achievable with icacls deny
# masks here - allow mode therefore means plain default ACLs outside.
Step "clean project" { CleanPath $Project "clean-project" }
Step "clean zone-root ($Zone)" { CleanPath $Zone "clean-zone" }
foreach ($s in $siblings) {
  Step ("clean " + $s.FullName) { CleanPath $s.FullName ("clean-" + $s.Name) }
}
foreach ($o in $outer) {
  Step ("clean " + $o) { CleanPath $o ("clean-" + (Split-Path $o -Leaf)) }
}
Step ("GRANT (OI)(CI)M project") { IcaclsRun @($Project, '/grant', $grantAce) "grant-project" }
Step ("DENY partial zone-root ($Zone)") { IcaclsRun @($Zone, '/deny', $partDeny) "deny-zone" }
if ($Reads -eq 'deny') {
  foreach ($s in $siblings) {
    Step ("DENY (OI)(CI)F " + $s.FullName) { IcaclsRun @($s.FullName, '/deny', $fullDeny) ("deny-" + $s.Name) }
  }
  foreach ($o in $outer) {
    Step ("DENY (OI)(CI)F " + $o) { IcaclsRun @($o, '/deny', $fullDeny) ("deny-outer-" + (Split-Path $o -Leaf)) }
  }
}

Write-Output ("done mode=" + $Reads + " ok=" + $script:okCount + " fail=" + $script:failCount)
if ($Apply -and $script:failCount -gt 0) { exit 1 }
exit 0
