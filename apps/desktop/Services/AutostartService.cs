using System;
using System.Diagnostics;

namespace TrayPoc.Services;

/// <summary>
/// Launch-at-login. Port of the Rust tauri-plugin-autostart usage (Windows-first):
/// a per-user HKCU \Run registry value, managed via reg.exe to avoid a
/// Windows-only target framework. No-op on other platforms for now.
/// </summary>
public static class AutostartService
{
    private const string RunKey = @"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "TimeTracker";

    public static bool IsEnabled()
    {
        if (!OperatingSystem.IsWindows())
            return false;
        return Run("reg", "query", RunKey, "/v", ValueName) == 0;
    }

    public static void SetEnabled(bool enabled)
    {
        if (!OperatingSystem.IsWindows())
            return;

        if (enabled)
        {
            string exe = Environment.ProcessPath ?? "";
            if (string.IsNullOrEmpty(exe))
                return;
            Run("reg", "add", RunKey, "/v", ValueName, "/t", "REG_SZ", "/d", $"\"{exe}\"", "/f");
        }
        else
        {
            Run("reg", "delete", RunKey, "/v", ValueName, "/f");
        }
    }

    private static int Run(string cmd, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo(cmd)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi);
            if (p is null) return -1;
            p.WaitForExit(3000);
            return p.HasExited ? p.ExitCode : -1;
        }
        catch
        {
            return -1;
        }
    }
}
