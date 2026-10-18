using System;
using System.Runtime.InteropServices;
// Test-only focus helper for a PID created by the integration test. Not shipped.
internal static class FocusTestWindow
{
    private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; public uint unused; }
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    private static int Main(string[] args)
    {
        uint targetId;
        if (args.Length != 1 || !UInt32.TryParse(args[0], out targetId)) return 2;
        IntPtr target = IntPtr.Zero;
        EnumWindowProc callback = delegate(IntPtr window, IntPtr unused) { uint id; GetWindowThreadProcessId(window, out id); if (id == targetId && IsWindowVisible(window)) { target = window; return false; } return true; };
        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        if (target == IntPtr.Zero) return 3;
        Message message; PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
        uint ignored;
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
        uint currentThread = GetCurrentThreadId();
        bool attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        try { ShowWindowAsync(target, 9); BringWindowToTop(target); SetForegroundWindow(target); }
        finally { if (attached) AttachThreadInput(currentThread, foregroundThread, false); }
        return GetForegroundWindow() == target ? 0 : 4;
    }
}
