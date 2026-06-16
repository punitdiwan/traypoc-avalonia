using System;
using System.IO;

namespace TrayPoc.Services;

/// <summary>
/// Single source of truth for on-disk locations. Mirrors the Rust app's layout
/// (config + auth + SQLite db + screenshots), all rooted under one per-user
/// folder: %APPDATA%\time-tracker on Windows, ~/.config/time-tracker on Linux.
/// </summary>
public static class AppPaths
{
    public static string BaseDir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "time-tracker");

    public static string ConfigFile => Path.Combine(BaseDir, "config.json");
    public static string AuthFile => Path.Combine(BaseDir, "auth.json");
    public static string DbFile => Path.Combine(BaseDir, "tracker.db");
    public static string ScreenshotsDir => Path.Combine(BaseDir, "screenshots");
    public static string LogsDir => Path.Combine(BaseDir, "logs");

    /// <summary>Creates the base directory if it does not yet exist, owner-only.</summary>
    public static void EnsureBaseDir()
    {
        Directory.CreateDirectory(BaseDir);
        RestrictToOwner(BaseDir);
    }

    /// <summary>
    /// Restrict a file or directory to its owner — 0600 for files, 0700 for
    /// directories — so secrets (auth tokens in auth.json) aren't world-readable.
    /// No-op on Windows, where the per-user %APPDATA% profile is already isolated.
    /// Best-effort: never throws.
    /// </summary>
    public static void RestrictToOwner(string path)
    {
        if (OperatingSystem.IsWindows())
            return;
        try
        {
            var mode = Directory.Exists(path)
                ? UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                : UnixFileMode.UserRead | UnixFileMode.UserWrite;
            File.SetUnixFileMode(path, mode);
        }
        catch
        {
            // best-effort — a stricter umask or unsupported FS shouldn't break the app
        }
    }
}
