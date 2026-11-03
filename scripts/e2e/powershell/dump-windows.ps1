param([int]$TargetPid = 0, [string]$ProcessName = "")
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $all) {
  try {
    $procId = $w.Current.ProcessId
    if ($TargetPid -ne 0 -and $procId -ne $TargetPid) { continue }
    if ($TargetPid -eq 0 -and $ProcessName -ne "") {
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if (-not $proc) { continue }
      if ($proc.ProcessName -notlike "*$ProcessName*") { continue }
    }
    Write-Output ('WINDOW hwnd=' + $w.Current.NativeWindowHandle + ' pid=' + $procId + ' name=[' + $w.Current.Name + '] class=[' + $w.Current.ClassName + '] type=' + $w.Current.ControlType.ProgrammaticName)
    $desc = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $i = 0
    foreach ($e in $desc) {
      if ($i -ge 80) { break }
      $i++
      $line = '  CHILD type=' + $e.Current.ControlType.ProgrammaticName + ' name=[' + $e.Current.Name + '] aid=[' + $e.Current.AutomationId + ']'
      try {
        $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $line += ' VALUE=[' + (($vp.Current.Value) -replace "`r?`n", ' ') + ']'
      } catch {}
      try {
        $null = $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $r = $e.Current.BoundingRectangle
        $line += ' rect=' + $r.X + ',' + $r.Y + ',' + $r.Width + ',' + $r.Height + ' invoke=yes'
      } catch {}
      Write-Output $line
    }
  } catch {}
}
