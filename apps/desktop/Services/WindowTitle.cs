using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace TrayPoc.Services;

/// <summary>
/// Port of the Rust <c>window_title.rs</c>: title and app name of the currently
/// focused window. Windows uses Win32; Linux shells out to xprop.
/// </summary>
public static class WindowTitle
{
    public static string? GetActiveWindowTitle()
    {
        try
        {
            if (OperatingSystem.IsWindows())
                return WindowsTitle();
            if (OperatingSystem.IsLinux())
                return LinuxTitle();
        }
        catch
        {
            // best-effort — title is informational only
        }
        return null;
    }

    /// <summary>Returns the process/application name of the foreground window
    /// (e.g. "chrome", "Code", "WINWORD"). Best-effort; returns null on error.</summary>
    public static string? GetActiveAppName()
    {
        try
        {
            if (OperatingSystem.IsWindows())
                return WindowsAppName();
            if (OperatingSystem.IsLinux())
                return LinuxAppName();
        }
        catch { }
        return null;
    }

    [SupportedOSPlatform("windows")]
    private static string? WindowsTitle()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero)
            return null;
        var buf = new StringBuilder(512);
        int len = GetWindowText(hwnd, buf, buf.Capacity);
        return len == 0 ? null : buf.ToString();
    }

    [SupportedOSPlatform("windows")]
    private static string? WindowsAppName()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        GetWindowThreadProcessId(hwnd, out uint pid);
        try
        {
            using var proc = Process.GetProcessById((int)pid);
            return proc.ProcessName;
        }
        catch { return null; }
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    private static string? LinuxTitle()
    {
        string? windowId = GetLinuxActiveWindowId();
        if (windowId is null) return null;

        string title = RunXprop("-id", windowId, "_NET_WM_NAME");
        int eq = title.IndexOf('=');
        if (eq < 0)
            return null;
        string quoted = title[(eq + 1)..].Trim().Trim('"');
        return string.IsNullOrEmpty(quoted) ? null : quoted;
    }

    private static string? LinuxAppName()
    {
        string? windowId = GetLinuxActiveWindowId();
        if (windowId is null) return null;

        // WM_CLASS returns: "processname", "ClassName"
        string wmClass = RunXprop("-id", windowId, "WM_CLASS");
        int eq = wmClass.IndexOf('=');
        if (eq < 0) return null;
        var parts = wmClass[(eq + 1)..].Trim().Split(',');
        // Prefer the second segment (class name, more human-readable)
        for (int i = parts.Length - 1; i >= 0; i--)
        {
            var name = parts[i].Trim().Trim('"');
            if (!string.IsNullOrEmpty(name)) return name;
        }
        return null;
    }

    private static string? GetLinuxActiveWindowId()
    {
        string active = RunXprop("-root", "_NET_ACTIVE_WINDOW");
        foreach (var token in active.Split(' ', '\t', '\n'))
        {
            var t = token.Trim();
            if (t.StartsWith("0x", StringComparison.Ordinal))
                return t;
        }
        return null;
    }

    private static string RunXprop(params string[] args)
    {
        var psi = new ProcessStartInfo("xprop")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi);
        if (p is null) return "";
        string outText = p.StandardOutput.ReadToEnd();
        p.WaitForExit(2000);
        return outText;
    }
}
