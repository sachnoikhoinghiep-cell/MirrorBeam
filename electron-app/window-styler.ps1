param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [int]$X = -1,
  [int]$Y = -1,
  [int]$Width = 430,
  [int]$Height = 860,
  [switch]$TopMost,
  [switch]$Borderless,
  [UInt64]$ChildHwnd = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Win32StyleOnly {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
}
"@

function Ptr([UInt64]$value) { return [IntPtr]::new([Int64]$value) }
function Get-Title([IntPtr]$hwnd) { $sb = [Text.StringBuilder]::new(512); [void][Win32StyleOnly]::GetWindowText($hwnd, $sb, $sb.Capacity); $sb.ToString() }
function Get-Class([IntPtr]$hwnd) { $sb = [Text.StringBuilder]::new(256); [void][Win32StyleOnly]::GetClassName($hwnd, $sb, $sb.Capacity); $sb.ToString() }

$child = [IntPtr]::Zero
if ($ChildHwnd -ne 0) {
  $child = Ptr $ChildHwnd
} else {
  $matches = New-Object System.Collections.Generic.List[object]
  $callback = [Win32StyleOnly+EnumWindowsProc]{
    param([IntPtr]$hwnd, [IntPtr]$lparam)
    if (-not [Win32StyleOnly]::IsWindowVisible($hwnd)) { return $true }
    [uint32]$windowProcessId = 0
    [void][Win32StyleOnly]::GetWindowThreadProcessId($hwnd, [ref]$windowProcessId)
    if ($windowProcessId -ne [uint32]$ProcessId) { return $true }
    if ([Win32StyleOnly]::GetParent($hwnd) -ne [IntPtr]::Zero) { return $true }
    $class = Get-Class $hwnd
    $title = Get-Title $hwnd
    if ($class -match 'ConsoleWindowClass') { return $true }
    $matches.Add([pscustomobject]@{ Hwnd = $hwnd; Title = $title; Class = $class }) | Out-Null
    return $true
  }
  [void][Win32StyleOnly]::EnumWindows($callback, [IntPtr]::Zero)
  if ($matches.Count -eq 0) {
    @{ ok = $false; message = 'Waiting for UxPlay/GStreamer mirror window'; processId = $ProcessId } | ConvertTo-Json -Compress
    exit 2
  }
  $pick = $matches | Where-Object { $_.Title -match 'iPhone|Mirror|AirPlay|UxPlay' -or $_.Class -match 'GStreamer|Direct3D|SDL|Qt|GLib|gdk|gtk|WindowsForms' } | Select-Object -First 1
  if (-not $pick) { $pick = $matches | Select-Object -First 1 }
  $child = $pick.Hwnd
}

$screenW = [Win32StyleOnly]::GetSystemMetrics(0)
$screenH = [Win32StyleOnly]::GetSystemMetrics(1)
if ($X -lt 0) { $X = [Math]::Max(0, [int](($screenW - $Width) / 2)) }
if ($Y -lt 0) { $Y = [Math]::Max(0, [int](($screenH - $Height) / 2)) }

$GWL_STYLE = -16
$GWL_EXSTYLE = -20
$WS_CAPTION = 0x00C00000
$WS_THICKFRAME = 0x00040000
$WS_MINIMIZEBOX = 0x00020000
$WS_MAXIMIZEBOX = 0x00010000
$WS_SYSMENU = 0x00080000
$WS_VISIBLE = 0x10000000
$WS_POPUP = 0x80000000
$WS_EX_TOPMOST = 0x00000008
$SWP_NOZORDER = 0x0004
$SWP_FRAMECHANGED = 0x0020
$SWP_SHOWWINDOW = 0x0040
$SW_SHOW = 5
$HWND_TOPMOST = [IntPtr]::new(-1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)

if ($Borderless) {
  $style = [UInt64]([Win32StyleOnly]::GetWindowLongPtr($child, $GWL_STYLE).ToInt64())
  $style = ($style -bor $WS_VISIBLE -bor $WS_POPUP)
  $style = ($style -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME -bor $WS_MINIMIZEBOX -bor $WS_MAXIMIZEBOX -bor $WS_SYSMENU)))
  [void][Win32StyleOnly]::SetWindowLongPtr($child, $GWL_STYLE, [IntPtr]::new([Int64]$style))
}

[void][Win32StyleOnly]::ShowWindow($child, $SW_SHOW)
$z = if ($TopMost) { $HWND_TOPMOST } else { [IntPtr]::Zero }
$flags = $SWP_FRAMECHANGED -bor $SWP_SHOWWINDOW
if (-not $TopMost) { $flags = $flags -bor $SWP_NOZORDER }
[void][Win32StyleOnly]::SetWindowPos($child, $z, $X, $Y, $Width, $Height, $flags)

@{ ok = $true; childHwnd = $child.ToInt64().ToString(); x = $X; y = $Y; width = $Width; height = $Height; borderless = [bool]$Borderless; topMost = [bool]$TopMost } | ConvertTo-Json -Compress
