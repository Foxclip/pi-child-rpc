# selftest.ps1 - verify the low-integrity sandbox end to end (used by
# hypervisor.mjs --selftest). The caller (Medium IL) must have pre-created
# and icacls'd <scratch> to (OI)(CI)Low, because a Low-IL process cannot
# create directories in Medium-IL parents.
#
# Output: one PASS/FAIL line per check + SELFTEST=PASS|FAIL on the last line.
# Exit: 0 = all pass, 1 = any fail.
# MUST stay pure ASCII (PS 5.1 cp1252 pitfall).
param([Parameter(Mandatory = $true)][string]$Scratch)

[Console]::OutputEncoding = [Text.Encoding]::UTF8

# child probe: run after the downgrade to prove child processes inherit Low
$childScript = Join-Path $Scratch "child-test.ps1"
Set-Content -Path $childScript -Value @'
try { Set-Content (Join-Path $env:USERPROFILE "il-child-probe.txt") "x" -ErrorAction Stop; "CHILD-USERPROFILE-ALLOWED" } catch { "CHILD-USERPROFILE-BLOCKED" }
'@

$code = @'
using System;
using System.Runtime.InteropServices;
public static class PiSelftestLow {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr h, int cls, IntPtr buf, int len, out int retLen);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SetTokenInformation(IntPtr h, int cls, IntPtr buf, int len);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool ConvertStringSidToSid(string sid, out IntPtr ptr);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool ConvertSidToStringSid(IntPtr pSid, out string strSid);
  const int TokenIntegrityLevel = 25;
  const int SE_GROUP_INTEGRITY = 0x20;
  public static string Drop() {
    IntPtr token = IntPtr.Zero;
    bool ok = OpenProcessToken(GetCurrentProcess(), 0x88, out token);
    if (!ok) return "FAIL open err=" + Marshal.GetLastWin32Error();
    int required = 0;
    // Zero-length call reports the required size in retLen; it returns FALSE by design.
    GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out required);
    if (required < 16) { CloseHandle(token); return "FAIL query-len required=" + required; }
    byte[] rb = new byte[required];
    GCHandle g = GCHandle.Alloc(rb, GCHandleType.Pinned);
    if (!GetTokenInformation(token, TokenIntegrityLevel, g.AddrOfPinnedObject(), required, out required)) {
      g.Free(); CloseHandle(token); return "FAIL read";
    }
    g.Free();
    string before = "";
    ConvertSidToStringSid(Marshal.ReadIntPtr(rb, 0), out before);
    IntPtr lowSid;
    if (!ConvertStringSidToSid("S-1-16-4096", out lowSid)) { CloseHandle(token); return "FAIL conv"; }
    byte[] buf = new byte[required];
    Marshal.WriteIntPtr(buf, 0, lowSid);
    Marshal.WriteInt32(buf, 8, SE_GROUP_INTEGRITY);
    GCHandle g1 = GCHandle.Alloc(buf, GCHandleType.Pinned);
    bool set = SetTokenInformation(token, TokenIntegrityLevel, g1.AddrOfPinnedObject(), required);
    g1.Free();
    if (!set) { CloseHandle(token); return "FAIL set err=" + Marshal.GetLastWin32Error(); }
    byte[] rb2 = new byte[required];
    GCHandle g2 = GCHandle.Alloc(rb2, GCHandleType.Pinned);
    string after = "";
    if (GetTokenInformation(token, TokenIntegrityLevel, g2.AddrOfPinnedObject(), required, out required)) {
      ConvertSidToStringSid(Marshal.ReadIntPtr(rb2, 0), out after);
    }
    g2.Free();
    CloseHandle(token);
    return "OK before=" + before + " after=" + after;
  }
}
'@

Add-Type -TypeDefinition $code
$status = [PiSelftestLow]::Drop()
Write-Output ("DROP " + $status)
$fail = 0
if ($status -notmatch "after=S-1-16-4096") { Write-Output "SELFTEST=FAIL (downgrade)"; exit 1 }

# T1: write into the Medium-IL user profile must be BLOCKED
$t1 = Join-Path $env:USERPROFILE "pi-selftest-medium.txt"
try {
  Set-Content -Path $t1 -Value "x" -ErrorAction Stop
  Write-Output "T1 userprofile-write=ALLOWED -> FAIL"
  Remove-Item $t1 -Force -ErrorAction SilentlyContinue
  $fail = 1
} catch {
  Write-Output "T1 userprofile-write=BLOCKED -> PASS"
}

# T2: HKCU registry write must be BLOCKED
try {
  Set-ItemProperty -Path "HKCU:\Software\PiSelftest" -Name probe -Value 1 -ErrorAction Stop
  Write-Output "T2 registry-write=ALLOWED -> FAIL"
  Remove-Item "HKCU:\Software\PiSelftest" -Force -ErrorAction SilentlyContinue
  $fail = 1
} catch {
  Write-Output "T2 registry-write=BLOCKED -> PASS"
}

# T3: write into the pre-created Low-IL dir must SUCCEED
try {
  Set-Content -Path (Join-Path $Scratch "low-write.txt") -Value "x" -ErrorAction Stop
  Write-Output "T3 low-IL-dir-write=ALLOWED -> PASS"
} catch {
  Write-Output ("T3 low-IL-dir-write=BLOCKED -> FAIL (" + $_.Exception.Message + ")")
  $fail = 1
}

# T4: a spawned child inherits Low IL
$childOut = (& powershell -NoProfile -ExecutionPolicy Bypass -File $childScript) -join ","
Write-Output ("T4 child " + $childOut)
if ($childOut -notmatch "CHILD-USERPROFILE-BLOCKED") { $fail = 1 }

# T5: reads of files written by the Medium-IL caller must still WORK (IL
# never blocks reads). The caller (hypervisor, Medium) created this file.
$probe = Join-Path $Scratch "read-probe.txt"
try {
  $v = Get-Content $probe -ErrorAction Stop
  Write-Output "T5 medium-IL-read=ALLOWED -> PASS"
} catch {
  Write-Output ("T5 medium-IL-read=BLOCKED -> FAIL (" + $_.Exception.Message + ")")
  $fail = 1
}

if ($fail -eq 0) { Write-Output "SELFTEST=PASS"; exit 0 } else { Write-Output "SELFTEST=FAIL"; exit 1 }
