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
    public PolicyState Policy { get; }
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
        Uploader = new SpacesUploader(Db, Api, Auth);
        Policy = new PolicyState();
        Tracker = new TrackerService(Db, Config, Activity, Uploader, Auth, Policy);
        Sync = new SyncService(Db, Auth, Api, Config, Policy);
    }

    /// <summary>
    /// Port of the Rust <c>clear_unuploaded</c> command: deletes API time logs,
    /// local screenshots, Spaces objects, and wipes the local DB. Returns the
    /// number of intervals removed.
    /// </summary>
    public async Task<long> ClearCapturesAsync()
    {
        // 1. Delete all time logs via the API. The server also removes the
        //    corresponding Spaces objects, so the desktop needs no bucket creds.
        if (Auth.IsAuthenticated)
        {
            try { await Api.DeleteAllTimeLogsAsync(Auth.AccessToken); }
            catch (Exception e) { Log.Error($"API delete failed: {e.Message}"); }
        }

        // 2. Delete every local screenshot + thumbnail. A recursive wipe is used
        //    rather than walking DB rows because pruned intervals no longer carry
        //    a screenshot_path, yet their thumbnails still sit on disk.
        if (Directory.Exists(AppPaths.ScreenshotsDir))
        {
            try { Directory.Delete(AppPaths.ScreenshotsDir, recursive: true); }
            catch (Exception e) { Log.Error($"screenshot cleanup failed: {e.Message}"); }
        }

        // 3. Wipe local SQLite records.
        return Db.ClearAll();
    }

    public void Dispose() => Db.Dispose();
}
