using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace TrayPoc.Services;

/// <summary>Details of a release that is newer than the running app.</summary>
public sealed record UpdateInfo(Version Version, string AssetName, string DownloadUrl);

/// <summary>
/// Minimal self-updater. On startup it asks the GitHub Releases API for the
/// latest release, and — if it is newer than the running build — downloads the
/// platform artifact (MSI on Windows, AppImage on Linux) and hands off to a
/// small relaunch helper that installs it once this process exits.
///
/// Everything here is best-effort: any failure returns quietly so the caller
/// can just launch the currently-installed version.
/// </summary>
public static class UpdateService
{
    private static readonly HttpClient Http = CreateClient();

    private static HttpClient CreateClient()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        // GitHub requires a User-Agent; the Accept header pins the API version.
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"{AppInfo.Name}/{AppInfo.Version}");
        http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return http;
    }

    /// <summary>File suffix of the release asset for the current platform, or null if unsupported.</summary>
    private static string? AssetSuffix =>
        OperatingSystem.IsWindows() ? ".msi" :
        OperatingSystem.IsLinux()   ? ".AppImage" :
        null;

    private static Version CurrentVersion =>
        Version.TryParse(AppInfo.Version, out var v) ? v : new Version(0, 0, 0);

    /// <summary>
    /// Returns the latest release if it is newer than the running build and has
    /// an asset for this platform; otherwise null (including on any error).
    /// </summary>
    public static async Task<UpdateInfo?> CheckForUpdateAsync(CancellationToken ct = default)
    {
        try
        {
            if (AssetSuffix is null)
                return null; // platform we don't ship installers for

            var url = $"https://api.github.com/repos/{AppInfo.RepoOwner}/{AppInfo.RepoName}/releases/latest";
            using var resp = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!resp.IsSuccessStatusCode)
                return null; // no releases yet (404), rate-limited, offline, …

            await using var stream = await resp.Content.ReadAsStreamAsync(ct);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var root = doc.RootElement;

            // Ignore drafts/prereleases — only ship stable releases to users.
            if (root.TryGetProperty("prerelease", out var pre) && pre.GetBoolean())
                return null;

            if (!root.TryGetProperty("tag_name", out var tagEl) ||
                !TryParseVersion(tagEl.GetString(), out var latest) ||
                latest <= CurrentVersion)
                return null;

            if (!root.TryGetProperty("assets", out var assets))
                return null;

            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.GetProperty("name").GetString();
                if (name is null || !name.EndsWith(AssetSuffix, StringComparison.OrdinalIgnoreCase))
                    continue;

                var download = asset.GetProperty("browser_download_url").GetString();
                if (!string.IsNullOrEmpty(download))
                    return new UpdateInfo(latest, name, download);
            }

            return null; // newer release, but no artifact for this platform
        }
        catch
        {
            return null; // best-effort: never let an update check crash startup
        }
    }

    /// <summary>
    /// Downloads the update and schedules its installation. Returns true if a
    /// relaunch was scheduled (the caller should then exit so the helper can
    /// take over); false means nothing was applied and the caller should
    /// continue on the current version.
    /// </summary>
    public static async Task<bool> DownloadAndApplyAsync(
        UpdateInfo update, IProgress<double>? progress = null, CancellationToken ct = default)
    {
        try
        {
            var file = Path.Combine(Path.GetTempPath(), update.AssetName);
            await DownloadAsync(update.DownloadUrl, file, progress, ct);

            if (OperatingSystem.IsWindows())
                return ApplyWindows(file);
            if (OperatingSystem.IsLinux())
                return ApplyLinux(file);

            return false;
        }
        catch
        {
            return false; // best-effort: fall back to the current version
        }
    }

    private static async Task DownloadAsync(
        string url, string destination, IProgress<double>? progress, CancellationToken ct)
    {
        using var resp = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();

        var total = resp.Content.Headers.ContentLength;
        await using var source = await resp.Content.ReadAsStreamAsync(ct);
        await using var dest = File.Create(destination);

        var buffer = new byte[81920];
        long received = 0;
        int read;
        while ((read = await source.ReadAsync(buffer, ct)) > 0)
        {
            await dest.WriteAsync(buffer.AsMemory(0, read), ct);
            received += read;
            if (total is > 0)
                progress?.Report((double)received / total.Value);
        }
    }

    /// <summary>
    /// Windows: a hidden PowerShell helper waits for this process to exit, runs
    /// the MSI (which auto-upgrades via the WiX MajorUpgrade rule, prompting for
    /// elevation), then relaunches the app.
    /// </summary>
    private static bool ApplyWindows(string msiPath)
    {
        var exe = Environment.ProcessPath;
        if (exe is null)
            return false;

        var pid = Environment.ProcessId;
        var script = Path.Combine(Path.GetTempPath(), $"traypoc-update-{pid}.ps1");
        File.WriteAllText(script,
            $$"""
            $ErrorActionPreference = 'SilentlyContinue'
            while (Get-Process -Id {{pid}} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }
            Start-Process msiexec -ArgumentList '/i','"{{msiPath}}"','/qb','/norestart' -Verb RunAs -Wait
            Start-Process '{{exe}}'
            """);

        Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{script}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
        });
        return true;
    }

    /// <summary>
    /// Linux: a /bin/sh helper waits for this process to exit, replaces the
    /// running AppImage file in place, then execs the updated build. Requires
    /// the app to be running as an AppImage (so $APPIMAGE is set).
    /// </summary>
    private static bool ApplyLinux(string appImagePath)
    {
        var target = Environment.GetEnvironmentVariable("APPIMAGE");
        if (string.IsNullOrEmpty(target))
            return false; // not an AppImage launch — nothing safe to replace

        var pid = Environment.ProcessId;
        var script = Path.Combine(Path.GetTempPath(), $"traypoc-update-{pid}.sh");
        File.WriteAllText(script,
            $"""
            #!/bin/sh
            while kill -0 {pid} 2>/dev/null; do sleep 0.2; done
            mv -f '{appImagePath}' '{target}'
            chmod +x '{target}'
            exec '{target}'
            """);

        Process.Start(new ProcessStartInfo
        {
            FileName = "/bin/sh",
            Arguments = $"\"{script}\"",
            UseShellExecute = false,
        });
        return true;
    }

    /// <summary>Parses a "v1.2.3" / "1.2.3" tag into a <see cref="Version"/>.</summary>
    private static bool TryParseVersion(string? tag, out Version version)
    {
        version = new Version(0, 0, 0);
        if (string.IsNullOrWhiteSpace(tag))
            return false;

        var trimmed = tag.TrimStart('v', 'V');
        return Version.TryParse(trimmed, out version!);
    }
}
