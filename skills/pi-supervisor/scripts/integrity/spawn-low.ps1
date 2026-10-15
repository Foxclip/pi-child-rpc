# spawn-low.ps1 - self-downgrade this process to Low integrity (S-1-16-4096)
# and execute a command in it. No admin, no elevation, no UAC.
#
# Protocol (avoids all shell quoting): the caller passes ONE argument:
#   -Spec <base64(json)>   base64 of {"exe":"C:\\...\\node.exe","args":["a.mjs","--flag","value with spaces"]}
# base64 keeps the payload free of quotes/backslashes/spaces, which
# PowerShell 5.1's command-line parser mangles (it mishandles \" sequences).
#
# Exit codes: 91 = downgrade failed, 92 = spec parse failed, otherwise the
# command's own exit code.
#
# MUST stay pure ASCII (Windows PowerShell 5.1 reads UTF-8 files without BOM
# as cp1252/ANSI, which corrupts non-ASCII bytes and can abort execution).
param([Parameter(Mandatory = $true)][string]$Spec)

[Console]::OutputEncoding = [Text.Encoding]::UTF8

try {
  $specJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Spec))
  # NOTE: must NOT be named $spec/$Spec — PS variables are case-insensitive, so
  # that is the SAME variable as the [string] param above, and the [string]
  # constraint would stringify the PSCustomObject ("@{exe=...}") at assignment.
  $specObj = $specJson | ConvertFrom-Json
  if (-not $specObj.Exe) { Write-Error "spec missing 'exe'"; exit 92 }
} catch {
  Write-Error "spec parse failed: $($_.Exception.Message)"
  exit 92
}

$code = @'
using System;
using System.Runtime.InteropServices;
public static class PiSpawnLow {
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
  // Open with TOKEN_QUERY | TOKEN_ADJUST_DEFAULT (0x88) - the mask that is
  // actually allowed on the current (Medium) token. The label buffer must be
  // exactly the size GetTokenInformation reports (queried with a zero-length
  // call first; it is 28 bytes on current Windows, not the textbook 24).
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
$status = [PiSpawnLow]::Drop()
Write-Output ("[spawn-low] " + $status)
if ($status -notmatch "after=S-1-16-4096") {
  Write-Error "self-downgrade to Low integrity failed"
  exit 91
}

$exe = $specObj.Exe
$exeArgs = if ($null -ne $specObj.Args) { @($specObj.Args) } else { @() }
& $exe @exeArgs
exit $LASTEXITCODE
