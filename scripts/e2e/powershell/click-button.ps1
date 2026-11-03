param([int]$TargetPid, [string]$WindowTitle, [string]$ButtonName, [switch]$Physical)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if ($Physical) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
}
function ForegroundInfo() {
  $h = [W32]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][W32]::GetWindowText($h, $sb, 512)
  $fgPid = 0
  [void][W32]::GetWindowThreadProcessId($h, [ref]$fgPid)
  return @{ hwnd = $h.ToInt64(); title = $sb.ToString(); pid = $fgPid }
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$target = $null
foreach ($w in $windows) {
  if ($WindowTitle -eq "" -or $w.Current.Name -eq $WindowTitle) { $target = $w; break }
}
if ($target -eq $null) { Write-Output "ERROR window-not-found"; exit 2 }
$bcond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $ButtonName))
)
$button = $target.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $bcond)
if ($button -eq $null) { Write-Output "ERROR button-not-found"; exit 3 }
$hwnd = [IntPtr]$target.Current.NativeWindowHandle
$r = $button.Current.BoundingRectangle
if (-not $Physical) {
  $inv = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $inv.Invoke()
  Start-Sleep -Milliseconds 300
  Write-Output ("CLICK method=UIAutomation.Invoke window=" + $target.Current.Name + " hwnd=" + $hwnd.ToInt64() + " button=" + $ButtonName + " rect=" + $r.X + "," + $r.Y + "," + $r.Width + "," + $r.Height)
  exit 0
}
$before = ForegroundInfo
# Make our own dialog topmost so the physical click cannot land on another
# application's window. This is a presentation of the target's consent UI.
[void][W32]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040)  # HWND_TOPMOST, NOSIZE|NOMOVE|SHOWWINDOW
Start-Sleep -Milliseconds 250
$r = $button.Current.BoundingRectangle
$x = [int]($r.X + $r.Width / 2)
$y = [int]($r.Y + $r.Height / 2)
[void][W32]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 80
[W32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[W32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
# Remove topmost again.
[void][W32]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040)  # HWND_NOTOPMOST
$after = ForegroundInfo
Write-Output ("CLICK method=SendInput-topmost window=" + $target.Current.Name + " hwnd=" + $hwnd.ToInt64() + " button=" + $ButtonName + " rect=" + $r.X + "," + $r.Y + "," + $r.Width + "," + $r.Height + " point=" + $x + "," + $y + " fg_before=" + $before.pid + ":" + $before.title + " fg_after=" + $after.pid + ":" + $after.title)
