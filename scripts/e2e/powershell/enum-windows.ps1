param([int]$TargetPid)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EW {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$list = New-Object System.Collections.ArrayList
$cb = [EW+EnumProc]{ param($h,$l)
  $p = 0
  [void][EW]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $TargetPid) {
    $t = New-Object System.Text.StringBuilder 512
    $c = New-Object System.Text.StringBuilder 256
    [void][EW]::GetWindowTextW($h, $t, 512)
    [void][EW]::GetClassNameW($h, $c, 256)
    [void]$list.Add(("hwnd=" + $h.ToInt64() + " visible=" + [EW]::IsWindowVisible($h) + " iconic=" + [EW]::IsIconic($h) + " class=[" + $c.ToString() + "] title=[" + $t.ToString() + "]"))
  }
  return $true
}
[void][EW]::EnumWindows($cb, [IntPtr]::Zero)
$list | ForEach-Object { Write-Output $_ }
