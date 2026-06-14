using System;
using System.IO;
using System.Threading.Tasks;

namespace TrayPoc.Services;

/// <summary>
/// Constructs and owns the long-lived services — the .NET counterpart of the
/// Rust <c>AppState</c>. Created once at startup and handed to the view models.
/// </summary>
public sealed class AppServices : IDisposable
{
    public ConfigState Config { get; }
    public Database Db { get; }
    public ActivityMonitor Activity { get; }
    public ApiClient Api { get; }
    public AuthService Auth { get; }
    public SpacesUploader Uploader { get; }
    public TrackerService Tracker { get; }
    public SyncService Sync { get; }

    public AppServices()
    {
        AppPaths.EnsureBaseDir();
        Config = new ConfigState();
        Db = new Database(AppPaths.DbFile);
        Activity = new ActivityMonitor();
        Activity.Start();
        Api = new ApiClient(() => Config.Current);
        Auth = new AuthService(Api, Config);
        Auth.Initialize();
        Uploader = new SpacesUploader(Db);
        Tracker = new TrackerService(Db, Config, Activity, Uploader);
        Sync = new SyncService(Db, Auth, Api, Config);
    }

    /// <summary>
    /// Port of the Rust <c>clear_unuploaded</c> command: deletes API time logs,
    /// local screenshots, Spaces objects, and wipes the local DB. Returns the
    /// number of intervals removed.
    /// </summary>
    public async Task<long> ClearCapturesAsync()
    {
        var info = Db.AllScreenshotInfo();
        var cfg = Config.Current;

        // 1. Delete all time logs from the API so the web dashboard clears.
        if (Auth.IsAuthenticated)
        {
            try { await Api.DeleteAllTimeLogsAsync(Auth.AccessToken); }
            catch (Exception e) { Console.Error.WriteLine($"API delete failed: {e.Message}"); }
        }

        // 2. Delete local files and Spaces objects (PNG + thumbnail).
        foreach (var (path, spacesUrl) in info)
        {
            TryDelete(path);
            string? dir = Path.GetDirectoryName(path);
            string stem = Path.GetFileNameWithoutExtension(path);
            if (dir is not null)
                TryDelete(Path.Combine(dir, $"{stem}_thumb.jpg"));

            if (spacesUrl is not null && cfg.IsConfigured())
            {
                try { await Uploader.DeleteFromSpacesAsync(spacesUrl, cfg); }
                catch (Exception e) { Console.Error.WriteLine($"spaces delete failed: {e.Message}"); }
                try { await Uploader.DeleteFromSpacesAsync(spacesUrl.Replace(".png", "_thumb.jpg"), cfg); }
                catch (Exception e) { Console.Error.WriteLine($"spaces thumb delete failed: {e.Message}"); }
            }
        }

        // 3. Remove now-empty date directories.
        if (Directory.Exists(AppPaths.ScreenshotsDir))
        {
            foreach (var d in Directory.GetDirectories(AppPaths.ScreenshotsDir))
            {
                try { Directory.Delete(d); } catch { /* not empty — leave it */ }
            }
        }

        // 4. Wipe local SQLite records.
        return Db.ClearAll();
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best-effort */ }
    }

    public void Dispose() => Db.Dispose();
}
