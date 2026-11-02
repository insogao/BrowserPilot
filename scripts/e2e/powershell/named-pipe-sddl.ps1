param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$PipeName
)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PipeSecurityProbe {
  [DllImport("ntdll.dll")]
  public static extern int NtQuerySystemInformation(int SystemInformationClass, IntPtr SystemInformation, int SystemInformationLength, out int ReturnLength);
  [DllImport("ntdll.dll")]
  public static extern int NtQueryObject(IntPtr Handle, int ObjectInformationClass, IntPtr ObjectInformation, int ObjectInformationLength, out int ReturnLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DuplicateHandle(IntPtr hSourceProcessHandle, IntPtr hSourceHandle, IntPtr hTargetProcessHandle, out IntPtr lpTargetHandle, uint dwDesiredAccess, bool bInheritHandle, uint dwOptions);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint GetFileType(IntPtr hFile);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern uint GetSecurityInfo(IntPtr handle, int ObjectType, uint SecurityInfo,
      out IntPtr ppsidOwner, out IntPtr ppsidGroup, out IntPtr ppDacl,
      out IntPtr ppSacl, out IntPtr ppSecurityDescriptor);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
      IntPtr pSecurityDescriptor, uint StringSDRevision, uint SecurityInformation,
      out IntPtr StringSecurityDescriptor, out uint StringSecurityDescriptorLen);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr hMem);
}
"@

$STATUS_INFO_LENGTH_MISMATCH = 0xC0000004
$SystemExtendedHandleInformation = 64
$PROCESS_DUP_HANDLE = 0x0040
$PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
$DUPLICATE_SAME_ACCESS = 0x00000002
$FILE_TYPE_PIPE = 3
$SE_KERNEL_OBJECT = 6
$OWNER_SECURITY_INFORMATION = 0x00000001
$DACL_SECURITY_INFORMATION = 0x00000004
$securityInfo = $OWNER_SECURITY_INFORMATION -bor $DACL_SECURITY_INFORMATION

$process = [PipeSecurityProbe]::OpenProcess(
  ($PROCESS_DUP_HANDLE -bor $PROCESS_QUERY_LIMITED_INFORMATION), $false, $TargetPid)
if ($process -eq [IntPtr]::Zero) {
  Write-Output ("ERROR open-process=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 2
}
$current = [PipeSecurityProbe]::GetCurrentProcess()

# Enumerate the target process's handles without opening the pipe (opening the
# single-instance pipe would connect a client and tear the session down).
$length = 1024 * 1024
$buffer = [IntPtr]::Zero
$returnLength = 0
$status = 0
for ($attempt = 0; $attempt -lt 8; $attempt++) {
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($length)
  $status = [PipeSecurityProbe]::NtQuerySystemInformation(
    $SystemExtendedHandleInformation, $buffer, $length, [ref]$returnLength)
  if ($status -ne $STATUS_INFO_LENGTH_MISMATCH) { break }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  $buffer = [IntPtr]::Zero
  $length = [Math]::Max($length * 2, $returnLength + 65536)
}
if ($status -ne 0) {
  Write-Output ("ERROR query-system-handles=0x" + ('{0:X8}' -f $status))
  if ($buffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
  [void][PipeSecurityProbe]::CloseHandle($process)
  exit 3
}

$count = [Runtime.InteropServices.Marshal]::ReadIntPtr($buffer, 0).ToInt64()
$entrySize = 40
$entriesOffset = 16
$found = 0
$duplicated = 0
$pipeHandles = 0
$sddl = ""
$objectName = ""
for ($i = 0; $i -lt $count; $i++) {
  $entry = $entriesOffset + $i * $entrySize
  $ownerPid = [Runtime.InteropServices.Marshal]::ReadIntPtr($buffer, $entry + 8).ToInt64()
  if ($ownerPid -ne $TargetPid) { continue }
  $handleValue = [Runtime.InteropServices.Marshal]::ReadIntPtr($buffer, $entry + 16)
  $dup = [IntPtr]::Zero
  $ok = [PipeSecurityProbe]::DuplicateHandle(
    $process, $handleValue, $current, [ref]$dup, 0, $false, $DUPLICATE_SAME_ACCESS)
  if (-not $ok -or $dup -eq [IntPtr]::Zero) { continue }
  $duplicated++
  if ([PipeSecurityProbe]::GetFileType($dup) -ne $FILE_TYPE_PIPE) {
    [void][PipeSecurityProbe]::CloseHandle($dup)
    continue
  }
  $pipeHandles++
  $nameBuf = [Runtime.InteropServices.Marshal]::AllocHGlobal(4096)
  $nameRet = 0
  $nameStatus = [PipeSecurityProbe]::NtQueryObject($dup, 1, $nameBuf, 4096, [ref]$nameRet)
  if ($nameStatus -eq 0) {
    $nameLen = [Runtime.InteropServices.Marshal]::ReadInt16($nameBuf, 0)
    $namePtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($nameBuf, 8)
    if ($nameLen -gt 0) {
      $candidate = [Runtime.InteropServices.Marshal]::PtrToStringUni($namePtr, [int]($nameLen / 2))
      if ($candidate -like "*browser-cli-import-*") {
        $objectName = $candidate
        $owner = [IntPtr]::Zero
        $group = [IntPtr]::Zero
        $dacl = [IntPtr]::Zero
        $sacl = [IntPtr]::Zero
        $sd = [IntPtr]::Zero
        $secStatus = [PipeSecurityProbe]::GetSecurityInfo(
          $dup, $SE_KERNEL_OBJECT, $securityInfo,
          [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$sd)
        if ($secStatus -eq 0) {
          $sddlPtr = [IntPtr]::Zero
          $sddlLen = 0
          if ([PipeSecurityProbe]::ConvertSecurityDescriptorToStringSecurityDescriptorW(
            $sd, 1, $securityInfo, [ref]$sddlPtr, [ref]$sddlLen)) {
            $sddl = [Runtime.InteropServices.Marshal]::PtrToStringUni($sddlPtr)
            [void][PipeSecurityProbe]::LocalFree($sddlPtr)
          } else {
            $sddl = "ERROR convert-sddl=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          }
          [void][PipeSecurityProbe]::LocalFree($sd)
          $found++
        } else {
          $sddl = "ERROR get-security-info=" + $secStatus
        }
      }
    }
  }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($nameBuf)
  [void][PipeSecurityProbe]::CloseHandle($dup)
  if ($found -gt 0) { break }
}
[Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
[void][PipeSecurityProbe]::CloseHandle($process)

Write-Output ("TARGET_PID=" + $TargetPid)
Write-Output ("DUPLICATED_HANDLES=" + $duplicated)
Write-Output ("PIPE_HANDLES=" + $pipeHandles)
if ($found -le 0) {
  Write-Output "ERROR import-pipe-handle-not-found"
  exit 4
}
Write-Output ("OBJECT=" + $objectName)
Write-Output ("EXPECTED=" + $PipeName)
Write-Output ("SDDL=" + $sddl)
