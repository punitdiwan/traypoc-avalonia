using System.Reflection;

namespace TrayPoc;

/// <summary>Single source of truth for app identity (used by the About dialog and updater).</summary>
public static class AppInfo
{
    public const string Name = "TrayPoc";
    public const string RepoOwner = "punitdiwan";
    public const string RepoName = "traypoc-avalonia";

    public static string RepoUrl => $"https://github.com/{RepoOwner}/{RepoName}";

    /// <summary>Current app version as "Major.Minor.Patch" (driven by the csproj/CI Version).</summary>
    public static string Version
    {
        get
        {
            var v = typeof(AppInfo).Assembly.GetName().Version;
            return v is null ? "0.0.0" : $"{v.Major}.{v.Minor}.{v.Build}";
        }
    }

    /// <summary>Display label for footers, e.g. "Time Tracker v1.1.0".</summary>
    public static string VersionLabel => $"Time Tracker v{Version}";
}
