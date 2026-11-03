// Win32 test helper for the release-candidate E2E harness.
//
// This is test-only infrastructure. It never changes product behavior:
// - no global process kill (callers pass verified HWNDs/PIDs);
// - the occluder is a separate WS_EX_NOACTIVATE window; the helper never calls
//   SetForegroundWindow for it, so the user's foreground window is unchanged;
// - all window/focus operations report the real result instead of pretending.
import fs from "node:fs";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WIN32_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Core -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public static class BpW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetFocus();
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

  public static List<IntPtr> Top() {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Kids(IntPtr parent) {
    List<IntPtr> list = new List<IntPtr>();
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Text(IntPtr h) { StringBuilder s = new StringBuilder(512); GetWindowTextW(h, s, 512); return s.ToString(); }
  public static string Cls(IntPtr h) { StringBuilder s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }
}

// Test-only occluder: a WS_EX_NOACTIVATE topmost window used to force
// Chromium's native occlusion path without ever touching the foreground
// window (no SetForegroundWindow, no activation).
public class BpOccluderForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
      cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
      return cp;
    }
  }
  public BpOccluderForm() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    BackColor = System.Drawing.Color.FromArgb(255, 0, 255);
    Text = "browserpilot-occluder";
  }
}
'@

$script:currentId = $null
$script:running = $true
$script:forms = @{}

function Reply($obj) {
  if ($null -ne $script:currentId) { $obj['id'] = $script:currentId }
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-Info([System.IntPtr]$h) {
  $r = [BpW+RECT]::new()
  $ok = [BpW]::GetWindowRect($h, [ref]$r)
  $procId = [uint32]0
  [void][BpW]::GetWindowThreadProcessId($h, [ref]$procId)
  $rect = $null
  if ($ok) { $rect = @([int]$r.Left, [int]$r.Top, [int]($r.Right - $r.Left), [int]($r.Bottom - $r.Top)) }
  return [ordered]@{
    hwnd = $h.ToInt64()
    pid = [int]$procId
    className = [BpW]::Cls($h)
    title = [BpW]::Text($h)
    visible = [bool][BpW]::IsWindowVisible($h)
    iconic = [bool][BpW]::IsIconic($h)
    rect = $rect
    above = ([BpW]::GetWindow($h, 3)).ToInt64()
    below = ([BpW]::GetWindow($h, 2)).ToInt64()
  }
}

function Mouse-LParam([int]$x, [int]$y) {
  return [IntPtr]((($y -shl 16) -bor ($x -band 0xFFFF)))
}

while ($script:running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    $script:currentId = $cmd.id
    $op = [string]$cmd.op
    switch ($op) {
      'ping' { Reply ([ordered]@{ ok = $true; pong = $true; pid = $PID }) }
      'foreground' { Reply ([ordered]@{ ok = $true; hwnd = ([BpW]::GetForegroundWindow()).ToInt64() }) }
      'screen' {
        Add-Type -AssemblyName System.Windows.Forms
        $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        Reply ([ordered]@{ ok = $true; rect = @([int]$s.X, [int]$s.Y, [int]$s.Width, [int]$s.Height) })
      }
      'listWindows' {
        $wantPid = 0
        if ($cmd.pid) { $wantPid = [int]$cmd.pid }
        $onlyVisible = [bool]$cmd.visibleOnly
        $list = New-Object System.Collections.ArrayList
        foreach ($h in [BpW]::Top()) {
          $info = Get-Info $h
          if ($wantPid -ne 0 -and $info.pid -ne $wantPid) { continue }
          if ($onlyVisible -and -not $info.visible) { continue }
          [void]$list.Add($info)
        }
        Reply ([ordered]@{ ok = $true; windows = @($list); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'state' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        Reply ([ordered]@{ ok = $true; window = (Get-Info $h); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'children' {
        $p = [System.IntPtr]([int64]$cmd.hwnd)
        $list = New-Object System.Collections.ArrayList
        foreach ($h in [BpW]::Kids($p)) {
          $r = [BpW+RECT]::new()
          [void][BpW]::GetClientRect($h, [ref]$r)
          $info = Get-Info $h
          [void]$list.Add([ordered]@{
            hwnd = $h.ToInt64(); className = [BpW]::Cls($h);
            clientWidth = [int]($r.Right - $r.Left); clientHeight = [int]($r.Bottom - $r.Top);
            visible = $info.visible; rect = $info.rect;
          })
        }
        Reply ([ordered]@{ ok = $true; children = @($list) })
      }
      'move' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $flags = 0x0010 -bor 0x0040
        if ([bool]$cmd.noActivate) { $flags = $flags -bor 0x0004 }
        $okMove = [BpW]::SetWindowPos($h, [System.IntPtr]::Zero, [int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height, [uint32]$flags)
        Reply ([ordered]@{ ok = [bool]$okMove; window = (Get-Info $h); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'mouse' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $x = [int]$cmd.x; $y = [int]$cmd.y
        $type = [string]$cmd.type
        $msg = 0x0200; $wp = 0
        if ($type -eq 'move') { $msg = 0x0200; $wp = [int]$cmd.buttons }
        elseif ($type -eq 'down') { $msg = 0x0201; $wp = 1 }
        elseif ($type -eq 'up') { $msg = 0x0202; $wp = 0 }
        elseif ($type -eq 'rdown') { $msg = 0x0204; $wp = 2 }
        elseif ($type -eq 'rup') { $msg = 0x0205; $wp = 0 }
        else { Reply ([ordered]@{ ok = $false; error = ('bad mouse type: ' + $type) }); continue }
        $okPost = [BpW]::PostMessageW($h, [uint32]$msg, [IntPtr]([int64]$wp), (Mouse-LParam $x $y))
        Reply ([ordered]@{ ok = [bool]$okPost; msg = $msg; x = $x; y = $y })
      }
      'realMouse' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $root = [BpW]::GetAncestor($h, 2)
        [void][BpW]::ShowWindow($root, 5)
        [void][BpW]::SetWindowPos($root, [System.IntPtr]::Zero, 0, 0, 0, 0, [uint32](0x0040 -bor 0x0002 -bor 0x0001))
        $fgOk = [BpW]::SetForegroundWindow($root)
        [void][BpW]::SetActiveWindow($root)
        [void][BpW]::SetFocus($h)
        Start-Sleep -Milliseconds 80
        $pt = [BpW+POINT]::new()
        $pt.X = [int]$cmd.x; $pt.Y = [int]$cmd.y
        [void][BpW]::ClientToScreen($h, [ref]$pt)
        $okPos = [BpW]::SetCursorPos($pt.X, $pt.Y)
        Start-Sleep -Milliseconds 60
        [BpW]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [BpW]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Reply ([ordered]@{ ok = [bool]$okPos; fgOk = [bool]$fgOk; screen = @($pt.X, $pt.Y); root = $root.ToInt64(); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'realClick' {
        # 纯输入：不做 ShowWindow/SetWindowPos/SetForegroundWindow。
        # 用于产品已用 user-explicit-show 呈现的窗口——再对窗口做 show/activate 会被 presentation
        # 策略按“自动化不得改变呈现”拒绝并可能把窗口重新隐藏，导致页面失焦、OS 按键无法到达。
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $pt = [BpW+POINT]::new()
        $pt.X = [int]$cmd.x
        $pt.Y = [int]$cmd.y
        [void][BpW]::ClientToScreen($h, [ref]$pt)
        $okPos = [BpW]::SetCursorPos($pt.X, $pt.Y)
        Start-Sleep -Milliseconds 60
        [BpW]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [BpW]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Reply ([ordered]@{ ok = [bool]$okPos; screen = @($pt.X, $pt.Y); root = ([BpW]::GetAncestor($h, 2)).ToInt64(); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'sendKeys' {
        if ($cmd.hwnd) {
          $h = [System.IntPtr]([int64]$cmd.hwnd)
          $root = [BpW]::GetAncestor($h, 2)
          [void][BpW]::ShowWindow($root, 5)
          [void][BpW]::SetWindowPos($root, [System.IntPtr]::Zero, 0, 0, 0, 0, [uint32](0x0040 -bor 0x0002 -bor 0x0001))
          [void][BpW]::SetForegroundWindow($root)
          [void][BpW]::SetActiveWindow($root)
          Start-Sleep -Milliseconds 80
        }
        $wshell = New-Object -ComObject WScript.Shell
        $text = [string]$cmd.text
        $wshell.SendKeys($text)
        Reply ([ordered]@{ ok = $true; text = $text; foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'realKey' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $root = [BpW]::GetAncestor($h, 2)
        [void][BpW]::ShowWindow($root, 5)
        [void][BpW]::SetWindowPos($root, [System.IntPtr]::Zero, 0, 0, 0, 0, [uint32](0x0040 -bor 0x0002 -bor 0x0001))
        $rootPid = [uint32]0
        $rootThread = [BpW]::GetWindowThreadProcessId($root, [ref]$rootPid)
        $selfThread = [BpW]::GetCurrentThreadId()
        [void][BpW]::AttachThreadInput($selfThread, $rootThread, $true)
        [void][BpW]::SetForegroundWindow($root)
        [void][BpW]::SetActiveWindow($root)
        [void][BpW]::SetFocus($h)
        Start-Sleep -Milliseconds 80
        $focusNow = ([BpW]::GetFocus()).ToInt64()
        $vk = [int]$cmd.vk
        $scan = [BpW]::MapVirtualKeyW([uint32]$vk, 0)
        $flags = 0
        if (-not [bool]$cmd.down) { $flags = 2 }
        [BpW]::keybd_event([byte]$vk, [byte]$scan, [uint32]$flags, [UIntPtr]::Zero)
        $focusAfter = ([BpW]::GetFocus()).ToInt64()
        [void][BpW]::AttachThreadInput($selfThread, $rootThread, $false)
        Reply ([ordered]@{ ok = $true; vk = $vk; scan = $scan; root = $root.ToInt64(); foreground = ([BpW]::GetForegroundWindow()).ToInt64(); focus = $focusAfter; focusBefore = $focusNow })
      }
      'focusWindow' {
        # 测试前置条件：真实用户在输入法里打字时，浏览器窗口就是 OS 前台窗口。
        # 这里只做“把测试目标窗口置前 + 置焦点”，并回报实际结果（不重试、不伪造）。
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $root = [BpW]::GetAncestor($h, 2)
        [void][BpW]::ShowWindow($root, 5)
        [void][BpW]::SetWindowPos($root, [System.IntPtr]::Zero, 0, 0, 0, 0, [uint32](0x0040 -bor 0x0002 -bor 0x0001))
        $rootPid = [uint32]0
        $rootThread = [BpW]::GetWindowThreadProcessId($root, [ref]$rootPid)
        $selfThread = [BpW]::GetCurrentThreadId()
        [void][BpW]::AttachThreadInput($selfThread, $rootThread, $true)
        $fgOk = [BpW]::SetForegroundWindow($root)
        [void][BpW]::SetActiveWindow($root)
        [void][BpW]::BringWindowToTop($root)
        $focusOk = [BpW]::SetFocus($h)
        Start-Sleep -Milliseconds 150
        $fg = ([BpW]::GetForegroundWindow()).ToInt64()
        $focus = ([BpW]::GetFocus()).ToInt64()
        [void][BpW]::AttachThreadInput($selfThread, $rootThread, $false)
        Reply ([ordered]@{
          ok = $true; root = $root.ToInt64(); foreground = $fg; focus = $focus;
          fgOk = [bool]$fgOk; focusOk = [bool]$focusOk;
          isForeground = ($fg -eq $root.ToInt64());
          widgetValid = [BpW]::IsWindow($h)
        })
      }
      'setForeground' {
        # Restore the pre-test foreground window (top-level HWND). No ShowWindow,
        # no SetWindowPos: this must not move or restyle the user's window.
        # Attach to both the current foreground thread and the target thread:
        # Windows' foreground lock otherwise rejects SetForegroundWindow from a
        # background PowerShell process.
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $root = [BpW]::GetAncestor($h, 2)
        $fg = [BpW]::GetForegroundWindow()
        $fgPid = [uint32]0
        $fgThread = [BpW]::GetWindowThreadProcessId($fg, [ref]$fgPid)
        $rootPid = [uint32]0
        $rootThread = [BpW]::GetWindowThreadProcessId($root, [ref]$rootPid)
        $selfThread = [BpW]::GetCurrentThreadId()
        if ($fgThread -ne 0) { [void][BpW]::AttachThreadInput($selfThread, $fgThread, $true) }
        if ($rootThread -ne 0) { [void][BpW]::AttachThreadInput($selfThread, $rootThread, $true) }
        [void][BpW]::BringWindowToTop($root)
        $fgOk = [BpW]::SetForegroundWindow($root)
        [void][BpW]::SetActiveWindow($root)
        if ($rootThread -ne 0) { [void][BpW]::AttachThreadInput($selfThread, $rootThread, $false) }
        if ($fgThread -ne 0) { [void][BpW]::AttachThreadInput($selfThread, $fgThread, $false) }
        Start-Sleep -Milliseconds 150
        Reply ([ordered]@{ ok = [bool]$fgOk; foreground = ([BpW]::GetForegroundWindow()).ToInt64(); requested = $root.ToInt64() })
      }
      'wheel' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $pt = [BpW+POINT]::new()
        $pt.X = [int]$cmd.x; $pt.Y = [int]$cmd.y
        [void][BpW]::ClientToScreen($h, [ref]$pt)
        $screenLParam = [IntPtr]((($pt.Y -shl 16) -bor ($pt.X -band 0xFFFF)))
        $delta = [int]$cmd.delta
        $wp = ([IntPtr]((($delta -band 0xFFFF) -shl 16)))
        $okPost = [BpW]::PostMessageW($h, 0x020A, $wp, $screenLParam)
        Reply ([ordered]@{ ok = [bool]$okPost; screen = @($pt.X, $pt.Y); delta = $delta })
      }
      'key' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $vk = [int]$cmd.vk
        $scan = [BpW]::MapVirtualKeyW([uint32]$vk, 0)
        if ([bool]$cmd.down) {
          $lparam = [IntPtr](1 -bor ($scan -shl 16))
          $okPost = [BpW]::PostMessageW($h, 0x0100, [IntPtr]([int64]$vk), $lparam)
        } else {
          $lparam = [IntPtr](0xC0000001 -bor ($scan -shl 16))
          $okPost = [BpW]::PostMessageW($h, 0x0101, [IntPtr]([int64]$vk), $lparam)
        }
        Reply ([ordered]@{ ok = [bool]$okPost; vk = $vk; scan = $scan })
      }
      'createOccluder' {
        $f = New-Object BpOccluderForm
        $f.Bounds = [System.Drawing.Rectangle]::new([int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height)
        $f.Show()
        $f.Refresh()
        [System.Windows.Forms.Application]::DoEvents()
        $h = $f.Handle
        $okPos = [BpW]::SetWindowPos($h, [System.IntPtr]::Zero, [int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height, [uint32](0x0010 -bor 0x0040))
        [System.Windows.Forms.Application]::DoEvents()
        $script:forms[$h.ToInt64()] = $f
        Reply ([ordered]@{ ok = [bool]$okPos; hwnd = $h.ToInt64(); window = (Get-Info $h); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'raise' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $okRaise = [BpW]::SetWindowPos($h, [System.IntPtr]::Zero, [int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height, [uint32](0x0010 -bor 0x0040))
        [System.Windows.Forms.Application]::DoEvents()
        Reply ([ordered]@{ ok = [bool]$okRaise; window = (Get-Info $h); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'raiseTopmost' {
        # Test-only: put the target above all non-topmost and topmost windows
        # without activating it. Used when the user's foreground app is maximized
        # and a real human input test needs the browser window to be reachable.
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $okRaise = [BpW]::SetWindowPos($h, [System.IntPtr](-1), [int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height, [uint32](0x0010 -bor 0x0040))
        [System.Windows.Forms.Application]::DoEvents()
        Reply ([ordered]@{ ok = [bool]$okRaise; window = (Get-Info $h); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'notTopmost' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $ok = [BpW]::SetWindowPos($h, [System.IntPtr](-2), 0, 0, 0, 0, [uint32](0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040))
        [System.Windows.Forms.Application]::DoEvents()
        Reply ([ordered]@{ ok = [bool]$ok; window = (Get-Info $h); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'closeOccluder' {
        $key = [int64]$cmd.hwnd
        if ($script:forms.ContainsKey($key)) {
          $f = $script:forms[$key]
          $f.Close()
          $f.Dispose()
          $script:forms.Remove($key)
        }
        [System.Windows.Forms.Application]::DoEvents()
        Reply ([ordered]@{ ok = $true; foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'closeAll' {
        foreach ($key in @($script:forms.Keys)) { $script:forms[$key].Close(); $script:forms[$key].Dispose() }
        $script:forms.Clear()
        [System.Windows.Forms.Application]::DoEvents()
        Reply ([ordered]@{ ok = $true; foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'shutdown' {
        foreach ($key in @($script:forms.Keys)) { $script:forms[$key].Close(); $script:forms[$key].Dispose() }
        $script:forms.Clear()
        Reply ([ordered]@{ ok = $true }); $script:running = $false
      }
      default { Reply ([ordered]@{ ok = $false; error = ('unknown op: ' + $op) }) }
    }
  } catch {
    Reply ([ordered]@{ ok = $false; error = $_.Exception.Message })
  }
}
`;

export class Win32Helper {
  constructor(psFile) {
    this.psFile = psFile;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
  }
  async start() {
    fs.writeFileSync(this.psFile, WIN32_PS, "utf8");
    this.child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.psFile],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000);
    });
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("win32 helper exited (code " + code + "): " + this.stderr.slice(-800)));
      }
      this.pending.clear();
    });
    const pong = await this.call("ping", {}, 20000);
    if (!pong?.ok) throw new Error("win32 helper ping failed: " + JSON.stringify(pong));
  }
  call(op, args = {}, timeoutMs = 20000) {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error("win32 helper is not running"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("win32 op " + op + " timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }
  async stop() {
    if (!this.child) return;
    try {
      await this.call("shutdown", {}, 8000).catch(() => undefined);
    } finally {
      try { this.child.kill(); } catch {}
      await sleep(150);
    }
  }
}
