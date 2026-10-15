# selftest.ps1 (user variant) — runs AS the dedicated account (via SSH).
# Verifies the confinement matrix + toolchain. Exit 0 = PASS.
#
#   -Project <dir>   the project the child must be able to read+write
#   -DenyDir <dir>   a directory that must be fully DENIED (read+write)
#   -HostUser <name> the host account; C:\Users\<name> must be DENIED
#   -ModelPort <n>   model server port reachable on 127.0.0.1 (default 8080)
param(
  [string]$Project,
  [string]$DenyDir = '',
  [string]$HostUser = '',
  [int]$ModelPort = 8080
)
$ErrorActionPreference = 'Continue'
$fail = 0
function Check([string]$label, [bool]$pass, [string]$detail = '') {
  if ($pass) { Write-Output "[ok]   $label" }
  else { Write-Output "[FAIL] $label $detail"; $script:fail++ }
}
function Probe-Write([string]$file) {
  # returns 'WRITTEN' | 'DENIED' — stderr is suppressed at the PS level because
  # cmd's "access denied" from the failed stdout-redirect setup leaks past 2>nul
  $cmd = "echo x > `"$file`" 2>nul & if exist `"$file`" (del /q `"$file`" >nul 2>nul & echo WRITTEN) else echo DENIED"
  $out = (& cmd /c $cmd 2>$null | Out-String).Trim()
  return $out
}
function Probe-Read([string]$dir) {
  # returns 'READABLE' | 'DENIED'
  $cmd = "dir /b `"$dir`" >nul 2>&1 && echo READABLE || echo DENIED"
  return (& cmd /c $cmd 2>&1 | Out-String).Trim()
}

Write-Output "whoami: $(whoami)"

# 1. profile (must work)
$pf = Probe-Write "$env:USERPROFILE\selftest-probe.txt"
Check "profile writable" ($pf -eq 'WRITTEN') $pf

# 2. project (must work)
if ($Project) {
  $pw = Probe-Write "$Project\selftest-probe.txt"
  Check "project writable" ($pw -eq 'WRITTEN') "$pw ($Project)"
  $pr = Probe-Read $Project
  Check "project readable" ($pr -eq 'READABLE') $pr
  # git (safe.directory via a throwaway config — the real one is written by runner.mjs)
  $gc = "$env:USERPROFILE\selftest-gitconfig"
  Set-Content -Path $gc -Value "[safe]`n`tdirectory = $Project`n"
  $env:GIT_CONFIG_GLOBAL = $gc
  $gitOut = (& git -C $Project status --short 2>&1 | Out-String).Trim()
  $env:GIT_CONFIG_GLOBAL = $null
  Remove-Item $gc -Force -ErrorAction SilentlyContinue
  Check "git works in project" ($gitOut -notmatch 'dubious ownership|fatal') ($gitOut.Substring(0, [Math]::Min(80, $gitOut.Length)))
}

# 3. deny zones
if ($DenyDir) {
  $dw = Probe-Write "$DenyDir\selftest-probe.txt"
  Check "deny-dir write blocked" ($dw -eq 'DENIED') "$dw ($DenyDir)"
  $dr = Probe-Read $DenyDir
  Check "deny-dir read blocked" ($dr -eq 'DENIED') $dr
}
if ($HostUser) {
  $hh = "C:\Users\$HostUser"
  if (Test-Path $hh) {
    $hw = Probe-Write "$hh\selftest-probe.txt"
    Check "host-home write blocked" ($hw -eq 'DENIED') $hw
    $hr = Probe-Read $hh
    Check "host-home read blocked" ($hr -eq 'DENIED') $hr
  }
}

# 4. toolchain
$node = (& node --version 2>&1 | Out-String).Trim()
Check "node available" ($node -match '^v\d') $node
$git = (& git --version 2>&1 | Out-String).Trim()
Check "git available" ($git -match 'git version') $git

# 5. model port (fast TCP connect, 3s timeout)
try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $ok = $tcp.ConnectAsync('127.0.0.1', $ModelPort).Wait(3000)
  $tcp.Close()
  Check "model port reachable" $ok "127.0.0.1:$ModelPort"
} catch {
  Check "model port reachable" $false $_.Exception.Message
}

if ($fail -gt 0) { Write-Output "SELFTEST=FAIL ($fail failed)"; exit 1 }
Write-Output "SELFTEST=PASS"
exit 0
