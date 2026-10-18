<#
.SYNOPSIS
  Tiny, self-restoring mouse moves for the opt-in Archie & Jumi --hook-loss-check.
.DESCRIPTION
  Records the cursor position (GetCursorPos), then for -Seconds alternately moves the cursor one
  pixel right and back with SendInput (MOUSEEVENTF_MOVE only), and finally restores the exact
  original position with SetCursorPos. No clicks, no wheel and no keyboard input are ever sent.

  -Mode Relative sends relative moves of +1 and -1. -Mode Absolute moves to the original position
  plus one pixel and back, which is immune to pointer acceleration. -Mode Auto (default) starts
  with relative moves and switches to absolute ones only if the first relative move did not move
  the cursor (for example when "Enhance pointer precision" swallows a 1-mickey move).

  -DryRun sends nothing: it prints the marshaled size of INPUT and the current cursor position.
  Output: a first line READY as soon as the type is compiled and the first move has been sent
  (READY dry-run for -DryRun), so callers can time against real moves rather than PowerShell
  start-up; the last output line is always one compact JSON object (sent, moved, restored...).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/jiggle-mouse.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [ValidateRange(0.1, 30)] [double] $Seconds = 2,
  [ValidateRange(5, 1000)] [int] $IntervalMs = 20,
  [ValidateSet('Auto', 'Relative', 'Absolute')] [string] $Mode = 'Auto',
  [switch] $DryRun
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

if (-not ('ArchieJumi.MouseJiggle' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace ArchieJumi {
  public sealed class JiggleResult {
    public bool DryRun; public int InputSize; public int PointerSize; public bool DpiAware;
    public string Mode = ""; public int Sent; public int Blocked; public int Moved;
    public int StartX; public int StartY; public bool Restored;
  }

  public static class MouseJiggle {
    const uint INPUT_MOUSE = 0;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    // Sequential layout aligns MOUSEINPUT to IntPtr: on x64 the 4-byte type is followed by
    // 4 bytes of padding and the 32-byte MOUSEINPUT, so Marshal.SizeOf(INPUT) is 40 (28 on x86).
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public MOUSEINPUT mi; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    public static int InputSize { get { return Marshal.SizeOf(typeof(INPUT)); } }

    // Written straight to stdout (not through the PowerShell pipeline) so a caller sees it at once.
    static void Announce(string line) {
      Console.Out.WriteLine(line);
      Console.Out.Flush();
    }

    // Physical pixels for GetCursorPos, SetCursorPos and the virtual-screen metrics.
    static bool UsePerMonitorDpi() {
      try { return SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero; }
      catch (EntryPointNotFoundException) { return false; }
    }

    static POINT Cursor() {
      POINT point;
      if (!GetCursorPos(out point)) throw new InvalidOperationException("GetCursorPos failed: " + Marshal.GetLastWin32Error());
      return point;
    }

    static bool Send(int dx, int dy, uint flags) {
      INPUT[] inputs = new INPUT[1];
      inputs[0].type = INPUT_MOUSE;
      inputs[0].mi.dx = dx;
      inputs[0].mi.dy = dy;
      inputs[0].mi.dwFlags = flags;
      return SendInput(1, inputs, InputSize) == 1;
    }

    static bool SendAbsolute(int x, int y) {
      int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
      int width = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN)), height = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
      // Normalized 0..65535 across the virtual desktop, aimed at the pixel centre.
      int nx = (int)Math.Round((x - left + 0.5) * 65536.0 / width);
      int ny = (int)Math.Round((y - top + 0.5) * 65536.0 / height);
      return Send(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
    }

    public static JiggleResult Run(double seconds, int intervalMs, string mode, bool dryRun) {
      JiggleResult result = new JiggleResult();
      result.DryRun = dryRun;
      result.InputSize = InputSize;
      result.PointerSize = IntPtr.Size;
      result.DpiAware = UsePerMonitorDpi();
      POINT start = Cursor();
      result.StartX = start.X;
      result.StartY = start.Y;
      result.Mode = mode.ToLowerInvariant();
      if (dryRun) { Announce("READY dry-run"); return result; }
      int expected = IntPtr.Size == 8 ? 40 : 28;
      if (InputSize != expected) throw new InvalidOperationException("Unexpected INPUT size " + InputSize + "; nothing was sent.");
      bool auto = mode == "Auto";
      string used = mode == "Absolute" ? "absolute" : "relative";
      bool away = false; // true while the cursor should sit one pixel right of the start
      bool announced = false;
      Stopwatch watch = Stopwatch.StartNew();
      try {
        while (watch.Elapsed.TotalSeconds < seconds) {
          POINT before = Cursor();
          bool ok = used == "absolute" ? SendAbsolute(start.X + (away ? 0 : 1), start.Y) : Send(away ? -1 : 1, 0, MOUSEEVENTF_MOVE);
          if (ok) result.Sent++; else result.Blocked++;
          if (!announced) { announced = true; Announce("READY"); }
          away = !away;
          Thread.Sleep(intervalMs);
          POINT after = Cursor();
          bool moved = after.X != before.X || after.Y != before.Y;
          if (moved) result.Moved++;
          // Pointer acceleration can swallow a 1-mickey relative move: continue with absolute moves.
          if (auto && used == "relative" && result.Sent == 1 && !moved) {
            used = "absolute";
            away = false;
            SetCursorPos(start.X, start.Y);
          }
        }
      } finally {
        result.Restored = SetCursorPos(start.X, start.Y);
        POINT end;
        if (result.Restored && GetCursorPos(out end)) result.Restored = end.X == start.X && end.Y == start.Y;
      }
      result.Mode = used;
      return result;
    }
  }
}
'@
}

$result = [ArchieJumi.MouseJiggle]::Run($Seconds, $IntervalMs, $Mode, [bool]$DryRun)
if ($DryRun) {
  Write-Output ('Dry run: Marshal.SizeOf(INPUT) = {0} bytes (IntPtr {1} bytes); cursor at ({2}, {3}). Nothing was sent.' -f $result.InputSize, $result.PointerSize, $result.StartX, $result.StartY)
  $summary = [ordered]@{ dryRun = $true; inputSize = $result.InputSize; pointerSize = $result.PointerSize; dpiAware = $result.DpiAware; cursor = [ordered]@{ x = $result.StartX; y = $result.StartY } }
} else {
  $summary = [ordered]@{ dryRun = $false; inputSize = $result.InputSize; mode = $result.Mode; sent = $result.Sent; blocked = $result.Blocked; moved = $result.Moved; restored = $result.Restored; dpiAware = $result.DpiAware }
}
Write-Output ([pscustomobject]$summary | ConvertTo-Json -Compress)
if (-not $DryRun -and -not $result.Restored) { exit 2 }
