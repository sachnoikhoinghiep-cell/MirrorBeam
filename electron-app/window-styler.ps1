param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [int]$X = -1,
  [int]$Y = -1,
  [int]$Width = 430,
  [int]$Height = 860,
  [switch]$TopMost,
  [switch]$Borderless,
  [UInt64]$ChildHwnd = 0,
  [switch]$GlobalFallback
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

function Find-WindowsByPredicate([scriptblock]$predicate) {
  $matches = New-Object System.Collections.Generic.List[object]
  $callback = [Win32StyleOnly+EnumWindowsProc]{
    param([IntPtr]$hwnd, [IntPtr]$lparam)
    if (-not [Win32StyleOnly]::IsWindowVisible($hwnd)) { return $true }
    if ([Win32StyleOnly]::GetParent($hwnd) -ne [IntPtr]::Zero) { return $true }
    [uint32]$windowProcessId = 0
    [void][Win32StyleOnly]::GetWindowThreadProcessId($hwnd, [ref]$windowProcessId)
    $class = Get-Class $hwnd
    $title = Get-Title $hwnd
    if ($class -match 'ConsoleWindowClass') { return $true }
    $obj = [pscustomobject]@{ Hwnd = $hwnd; Title = $title; Class = $class; ProcessId = [int]$windowProcessId }
    if (& $predicate $obj) { $matches.Add($obj) | Out-Null }
    return $true
  }
  [void][Win32StyleOnly]::EnumWindows($callback, [IntPtr]::Zero)
  return $matches
}

function Score-Window($w) {
  $score = 0
  if ($w.Title -match 'Direct3D11 renderer') { $score += 1000 }
  if ($w.Title -match 'GStreamer|renderer|AirPlay|iPhone|Mirror|UxPlay') { $score += 300 }
  if ($w.Class -match 'Direct3D|GStreamer|SDL|Qt|GLib|gdk|gtk|WindowsForms') { $score += 200 }
  if ($w.Title -match 'iPhone Mirror - AirPlay Receiver|iPhone Mirror$|MirrorBeam') { $score -= 700 }
  if ($w.Class -match 'Chrome_WidgetWin|CabinetWClass|Progman|Shell_TrayWnd') { $score -= 500 }
  return $score
}

$child = [IntPtr]::Zero
$chosen = $null
if ($ChildHwnd -ne 0) {
  $child = Ptr $ChildHwnd
  $chosen = [pscustomobject]@{ Hwnd = $child; Title = Get-Title $child; Class = Get-Class $child; ProcessId = $ProcessId }
} else {
  $pidMatches = Find-WindowsByPredicate { param($w) $w.ProcessId -eq $ProcessId }
  $ranked = @($pidMatches | Sort-Object @{ Expression = { Score-Window $_ }; Descending = $true })
  if ($ranked.Count -gt 0 -and (Score-Window $ranked[0]) -gt -100) { $chosen = $ranked[0] }

  if (-not $chosen -or (Score-Window $chosen) -lt 200) {
    $globalMatches = Find-WindowsByPredicate {
      param($w)
      ($w.Title -match 'Direct3D11 renderer|GStreamer|AirPlay|UxPlay' -or $w.Class -match 'Direct3D|GStreamer|SDL|Qt|GLib|gdk|gtk') -and
      ($w.Title -notmatch 'iPhone Mirror - AirPlay Receiver')
    }
    $globalRanked = @($globalMatches | Sort-Object @{ Expression = { Score-Window $_ }; Descending = $true })
    if ($globalRanked.Count -gt 0 -and (Score-Window $globalRanked[0]) -gt 0) { $chosen = $globalRanked[0] }
  }

  if (-not $chosen) {
    @{ ok = $false; message = 'Waiting for UxPlay/GStreamer/Direct3D11 mirror window'; processId = $ProcessId } | ConvertTo-Json -Compress
    exit 2
  }
  $child = $chosen.Hwnd
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
  [Int64]$style = [Win32StyleOnly]::GetWindowLongPtr($child, $GWL_STYLE).ToInt64()
  [Int64]$removeMask = [Int64]($WS_CAPTION -bor $WS_THICKFRAME -bor $WS_MINIMIZEBOX -bor $WS_MAXIMIZEBOX -bor $WS_SYSMENU)
  $style = (($style -bor [Int64]$WS_VISIBLE -bor [Int64]$WS_POPUP) -band (-bnot $removeMask))
  [void][Win32StyleOnly]::SetWindowLongPtr($child, $GWL_STYLE, [IntPtr]::new($style))
}

[void][Win32StyleOnly]::ShowWindow($child, $SW_SHOW)
$z = if ($TopMost) { $HWND_TOPMOST } else { [IntPtr]::Zero }
$flags = $SWP_FRAMECHANGED -bor $SWP_SHOWWINDOW
if (-not $TopMost) { $flags = $flags -bor $SWP_NOZORDER }
[void][Win32StyleOnly]::SetWindowPos($child, $z, $X, $Y, $Width, $Height, $flags)

@{ ok = $true; childHwnd = $child.ToInt64().ToString(); title = (Get-Title $child); class = (Get-Class $child); processId = $chosen.ProcessId; x = $X; y = $Y; width = $Width; height = $Height; borderless = [bool]$Borderless; topMost = [bool]$TopMost } | ConvertTo-Json -Compress
