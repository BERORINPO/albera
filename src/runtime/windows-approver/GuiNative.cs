using System.Runtime.InteropServices;

namespace Albera.Approver;

// The three Win32 calls the GUI mode needs, nothing else: flash the taskbar button (the window is shown without taking focus, so this is how the person notices it), bring the
// window the person just clicked to the front before Windows Hello asks, and drop the console the exe was started with (the tray mode runs from the Run key and must not keep a
// console window). Windows Hello itself is still called through WindowsHello.cs only.
internal static class GuiNative
{
    private const uint FlashTray = 2, FlashCaption = 1, FlashUntilForeground = 12;

    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo
    {
        public uint Size;
        public IntPtr Window;
        public uint Flags;
        public uint Count;
        public uint TimeoutMs;
    }

    public static void FlashTaskbar(IntPtr window)
    {
        FlashInfo info = new() { Size = (uint)Marshal.SizeOf<FlashInfo>(), Window = window, Flags = FlashCaption | FlashTray | FlashUntilForeground, Count = 5, TimeoutMs = 0 };
        _ = FlashWindowEx(ref info);
    }

    public static void BringToFront(IntPtr window) => _ = SetForegroundWindow(window);

    public static void DetachConsole() => _ = FreeConsole();

    [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FlashInfo info);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("kernel32.dll")] private static extern bool FreeConsole();
}
