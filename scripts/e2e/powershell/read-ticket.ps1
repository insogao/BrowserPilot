param([int]$TargetPid)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TicketWindowEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$handles = New-Object System.Collections.ArrayList
$callback = [TicketWindowEnum+EnumProc]{
  param($hwnd, $lparam)
  $owner = 0
  [void][TicketWindowEnum]::GetWindowThreadProcessId($hwnd, [ref]$owner)
  if ($owner -eq $TargetPid) { [void]$handles.Add($hwnd) }
  return $true
}
[void][TicketWindowEnum]::EnumWindows($callback, [IntPtr]::Zero)
$editCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Browser CLI cookie import ticket"))
)
foreach ($hwnd in $handles) {
  try {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($window -eq $null) { continue }
    $edit = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond)
    if ($edit -ne $null) {
      $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      Write-Output $vp.Current.Value
      exit 0
    }
  } catch {
    # Hidden/destroyed windows can throw; try the next HWND.
  }
}
exit 1
