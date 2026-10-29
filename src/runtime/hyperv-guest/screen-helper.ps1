# ALBERA screen helper ("satsueikakari"). OPT-IN, installed only into the VMs named with --guest-capture or
# capture: "guest" (spec/architecture.md decision log). Runs INSIDE the guest, in the interactive session of the
# logged-on user, started by the scheduled task "ALBERA Screen Helper" at logon (albera-runtime guest-capture install).
# Every ~1 s it saves the primary screen as C:\ProgramData\Albera\frame-<UTC ticks>.png: written to a temp file and then
# renamed to a new name, so a reader never sees half a file and never blocks the next frame (replacing one fixed name
# failed while a reader had it open). Older frames are deleted, so only the newest is kept. It stops when
# C:\ProgramData\Albera\stop exists.
# Windows PowerShell 5.1, built-in .NET only, no network. ASCII only (5.1 reads a BOM-less file as ANSI).
#
# Why two ways: on a GPU-partitioned VM the session has no display path at all (the screen is "WinDisc", 1024x768),
# so copying the screen gives black. The windows are still drawn by DWM, so then each visible top-level window is
# asked to paint itself (PrintWindow) and they are stacked bottom to top on one canvas.
$ErrorActionPreference = 'Stop'
$Dir = 'C:\ProgramData\Albera'
$Temp = Join-Path $Dir 'frame.tmp'
$Stop = Join-Path $Dir 'stop'
$IntervalMs = 1000

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
# Compiled with the in-box C# compiler at start (can take a minute on a cold disk); nothing is downloaded.
Add-Type -ReferencedAssemblies System.Drawing -Namespace Albera -Name Screen -MemberDefinition @'
delegate bool EnumProc(IntPtr h, IntPtr l);
[StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
[DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr result);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
public static void Compose(System.Drawing.Bitmap canvas) {
  var windows = new System.Collections.Generic.List<IntPtr>();
  EnumWindows((h, l) => { windows.Add(h); return true; }, IntPtr.Zero);
  windows.Reverse(); // EnumWindows lists top first; paint the bottom first
  using (var g = System.Drawing.Graphics.FromImage(canvas)) {
    foreach (var h in windows) {
      int cloaked; RECT r;
      if (!IsWindowVisible(h) || IsIconic(h)) continue;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) continue; // DWMWA_CLOAKED
      if (!GetWindowRect(h, out r)) continue;
      int w = r.R - r.L, ht = r.B - r.T;
      if (w < 1 || ht < 1 || w > 8192 || ht > 8192) continue;
      // PrintWindow waits for the window's own thread: a busy window (a Save dialog listing folders) would hold the
      // frame for seconds. Skip a window that does not answer WM_NULL within 100 ms (SMTO_ABORTIFHUNG).
      IntPtr ignored;
      if (SendMessageTimeout(h, 0, IntPtr.Zero, IntPtr.Zero, 2, 100, out ignored) == IntPtr.Zero) continue;
      using (var b = new System.Drawing.Bitmap(w, ht))
      using (var bg = System.Drawing.Graphics.FromImage(b)) {
        IntPtr dc = bg.GetHdc();
        try { PrintWindow(h, dc, 2); } finally { bg.ReleaseHdc(dc); } // PW_RENDERFULLCONTENT
        g.DrawImage(b, r.L, r.T);
      }
    }
  }
}
'@
# Real pixels, not DPI-scaled ones: without this, a 150 % display would be captured at two thirds of its size.
[void][Albera.Screen]::SetProcessDPIAware()

$failures = 0
while (-not [System.IO.File]::Exists($Stop)) {
  try {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    $b = $screen.Bounds
    $bmp = [System.Drawing.Bitmap]::new($b.Width, $b.Height)
    try {
      $copied = $false
      if ($screen.DeviceName -ne 'WinDisc') {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try { $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $copied = $true } catch {} finally { $g.Dispose() }
      }
      if (-not $copied) { [Albera.Screen]::Compose($bmp) }
      $bmp.Save($Temp, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $bmp.Dispose() }
    $name = 'frame-{0:D20}.png' -f [DateTime]::UtcNow.Ticks
    [System.IO.File]::Move($Temp, (Join-Path $Dir $name))
    foreach ($old in [System.IO.Directory]::GetFiles($Dir, 'frame-*.png')) {
      if ([System.IO.Path]::GetFileName($old) -ne $name) { try { [System.IO.File]::Delete($old) } catch {} } # a reader has it: next time
    }
    $failures = 0
  }
  catch {
    # Locked screen or secure desktop: skip this frame (the host refuses a stale frame).
    # The reason stays inside the guest, for whoever looks; ten failures in a row end the process and the task starts it again.
    try { [System.IO.File]::WriteAllText((Join-Path $Dir 'last-error.txt'), "$([DateTime]::Now.ToString('s')) $($_.Exception.GetType().FullName): $($_.Exception.Message)") } catch {}
    if (++$failures -ge 10) { exit 1 }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
