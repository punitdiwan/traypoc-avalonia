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

    /// <summary>Creates the base directory if it does not yet exist.</summary>
    public static void EnsureBaseDir() => Directory.CreateDirectory(BaseDir);
}
