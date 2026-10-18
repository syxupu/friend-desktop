using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Read-only Win32 queries. No screenshots, hooks, keystrokes or network access.
internal static class ForegroundReader
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int count);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private static readonly Dictionary<string, string> AppNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static object Capture()
    {
        long now = (DateTime.UtcNow.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond;
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) return new { status = "unavailable", observedAt = now };
        uint id;
        if (GetWindowThreadProcessId(window, out id) == 0 || id == 0) return new { status = "unavailable", observedAt = now };
        StringBuilder title = new StringBuilder(32768);
        GetWindowTextW(window, title, title.Capacity);
        string executablePath = null;
        IntPtr process = OpenProcess(0x1000, false, id); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process != IntPtr.Zero)
        {
            try
            {
                uint size = 32768;
                StringBuilder image = new StringBuilder((int)size);
                if (QueryFullProcessImageNameW(process, 0, image, ref size)) executablePath = image.ToString();
            }
            finally { CloseHandle(process); }
        }
        string processName = null;
        string appName = null;
        if (executablePath != null)
        {
            processName = Path.GetFileName(executablePath);
            if (!AppNames.TryGetValue(executablePath, out appName))
            {
                try { appName = FileVersionInfo.GetVersionInfo(executablePath).FileDescription; } catch { }
                if (String.IsNullOrWhiteSpace(appName)) appName = processName;
                if (AppNames.Count >= 64) AppNames.Clear();
                AppNames[executablePath] = appName;
            }
        }
        else
        {
            try { using (Process fallback = Process.GetProcessById((int)id)) processName = fallback.ProcessName + ".exe"; } catch { }
            appName = processName;
        }
        uint checkId;
        if (GetForegroundWindow() != window || GetWindowThreadProcessId(window, out checkId) == 0 || checkId != id)
            return new { status = "unavailable", observedAt = now };
        return new { status = "ok", observedAt = now, windowHandle = window.ToInt64().ToString(), processId = id,
            processName = processName, executablePath = executablePath, appName = appName, title = title.ToString() };
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        bool watch = Array.IndexOf(args, "--watch") >= 0;
        Process parent = null;
        int parentArgument = Array.IndexOf(args, "--parent-pid");
        if (parentArgument >= 0)
        {
            int parentId;
            if (parentArgument + 1 >= args.Length || !Int32.TryParse(args[parentArgument + 1], out parentId)) return 2;
            try { parent = Process.GetProcessById(parentId); } catch { return 0; }
        }
        try
        {
            do
            {
                if (parent != null && parent.HasExited) break;
                Console.WriteLine(Json.Serialize(Capture()));
                Console.Out.Flush();
                if (watch) Thread.Sleep(1000);
            } while (watch);
            return 0;
        }
        catch (IOException) { return 0; } // Parent closed the pipe.
        catch { return 1; }
        finally { if (parent != null) parent.Dispose(); }
    }
}
