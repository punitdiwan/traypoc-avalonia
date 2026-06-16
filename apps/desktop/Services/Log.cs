using System;
using System.IO;

namespace TrayPoc.Services;

/// <summary>
/// Minimal thread-safe file logger. Writes a daily file under
/// <see cref="AppPaths.LogsDir"/> (<c>app-YYYYMMDD.log</c>), prunes files older
/// than <see cref="RetentionDays"/>, and mirrors to stderr. Replaces the
/// scattered <c>Console.Error.WriteLine</c> calls so this tray app (which has no
/// console when launched normally) is still diagnosable in the field.
/// Logging must never crash the app — every path is best-effort.
/// </summary>
public static class Log
{
    private const int RetentionDays = 14;
    private static readonly object Gate = new();
    private static bool _initialized;

    public static void Init()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.LogsDir);
            AppPaths.RestrictToOwner(AppPaths.LogsDir);
            Prune();
            _initialized = true;
        }
        catch
        {
            // leave _initialized false; Write() still mirrors to stderr
        }
    }

    public static void Info(string msg) => Write("INFO", msg);
    public static void Warn(string msg) => Write("WARN", msg);
    public static void Error(string msg) => Write("ERROR", msg);

    private static void Write(string level, string msg)
    {
        string line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {msg}";
        Console.Error.WriteLine(line);
        if (!_initialized)
            return;
        try
        {
            string file = Path.Combine(AppPaths.LogsDir, $"app-{DateTime.Now:yyyyMMdd}.log");
            lock (Gate)
                File.AppendAllText(file, line + Environment.NewLine);
        }
        catch
        {
            // best-effort
        }
    }

    private static void Prune()
    {
        var cutoff = DateTime.Now.AddDays(-RetentionDays);
        foreach (var f in Directory.GetFiles(AppPaths.LogsDir, "app-*.log"))
        {
            try
            {
                if (File.GetLastWriteTime(f) < cutoff)
                    File.Delete(f);
            }
            catch
            {
                // best-effort
            }
        }
    }
}
