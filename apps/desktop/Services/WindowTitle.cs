using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace TrayPoc.Services;

/// <summary>
/// Port of the Rust <c>window_title.rs</c>: title of the currently focused
/// window. Windows uses Win32 GetForegroundWindow/GetWindowText; Linux shells
/// out to xprop (_NET_ACTIVE_WINDOW → _NET_WM_NAME).
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

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    private static string? LinuxTitle()
    {
        string active = RunXprop("-root", "_NET_ACTIVE_WINDOW");
        string? windowId = null;
        foreach (var token in active.Split(' ', '\t', '\n'))
        {
            var t = token.Trim();
            if (t.StartsWith("0x", StringComparison.Ordinal))
                windowId = t;
        }
        if (windowId is null)
            return null;

        string title = RunXprop("-id", windowId, "_NET_WM_NAME");
        int eq = title.IndexOf('=');
        if (eq < 0)
            return null;
        string quoted = title[(eq + 1)..].Trim().Trim('"');
        return string.IsNullOrEmpty(quoted) ? null : quoted;
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
