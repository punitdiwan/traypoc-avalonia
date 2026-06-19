using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;
using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>
/// Port of the React <c>useSyncLoop</c>: every 30s, pushes intervals that have
/// been uploaded to Spaces (but not yet synced) to the Go API, refreshing the
/// access token on a 401 and retrying once.
/// </summary>
public sealed class SyncService
{
    private const int IntervalMs = 30_000;
    // How far back to reconcile web-side deletions each tick. Bounds the id set we
    // fetch; intervals older than this are assumed settled.
    private const int ReconcileWindowDays = 14;

    private readonly Database _db;
    private readonly AuthService _auth;
    private readonly ApiClient _api;
    private readonly ConfigState _config;
    private readonly PolicyState _policy;

    private CancellationTokenSource? _cts;

    public SyncService(Database db, AuthService auth, ApiClient api, ConfigState config, PolicyState policy)
    {
        _db = db;
        _auth = auth;
        _api = api;
        _config = config;
        _policy = policy;
    }

    public void Start()
    {
        if (_cts is not null)
            return;
        _cts = new CancellationTokenSource();
        _ = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try { await RunOnceAsync(ct); }
                catch (Exception e) { Log.Error($"sync: {e.Message}"); }
                await Task.Delay(IntervalMs, ct);
            }
        }
        catch (OperationCanceledException) { }
    }

    private async Task RunOnceAsync(CancellationToken ct)
    {
        if (!_auth.IsAuthenticated)
            return;
        string token = _auth.AccessToken;
        if (string.IsNullOrEmpty(token))
            return;

        // Poll the employer policy first, so a tracking-disabled change halts the
        // tracker before we attempt to push (and the API would reject anyway).
        await PollPolicyAsync(ct);

        var pending = _db.PendingSyncIntervals();
        long duration = _config.Current.CaptureIntervalSecs;
        if (duration <= 0)
            duration = 600;

        foreach (var interval in pending)
        {
            // Automatic intervals only sync once their screenshot has reached Spaces;
            // manual intervals have no screenshot, so they sync immediately.
            if (!interval.Manual && interval.SpacesUrl is null)
                continue;

            var ended = DateTimeOffset.Parse(interval.StartTime, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
            var started = ended.AddSeconds(-duration);

            var body = new TimeLogRequest
            {
                ProjectId = interval.ProjectId,
                StartedAt = Iso(started),
                EndedAt = Iso(ended),
                DurationSeconds = duration,
                ActivityPercent = (int)Math.Round(interval.ActivityPercent),
                ScreenshotUrl = interval.SpacesUrl,
                ThumbnailUrl = interval.SpacesUrl?.Replace(".png", "_thumb.jpg"),
                WindowTitle = interval.WindowTitle,
            };

            var resp = await _api.PostTimeLogAsync(body, token, ct);

            if ((int)resp.StatusCode == 401)
            {
                resp.Dispose();
                if (!await _auth.RefreshAsync())
                    return;
                token = _auth.AccessToken;
                if (string.IsNullOrEmpty(token))
                    return;
                resp = await _api.PostTimeLogAsync(body, token, ct);
            }

            if (resp.IsSuccessStatusCode)
            {
                try
                {
                    string json = await resp.Content.ReadAsStringAsync(ct);
                    string apiId = ExtractId(json);
                    if (!string.IsNullOrEmpty(apiId))
                        _db.SetSynced(interval.Id, apiId);
                }
                catch
                {
                    // Non-fatal — interval retries next tick.
                }
            }
            resp.Dispose();
        }

        // Reclaim disk: once an interval is uploaded AND synced, its local full-res
        // PNG is redundant. Self-healing — also clears any backlog left by a crash
        // or an earlier failed delete. Thumbnails are kept for the Work Diary.
        PruneUploadedScreenshots();

        // Pull down deletions made on the web (employee/owner removed a screenshot).
        await ReconcileDeletionsAsync(ct);
    }

    /// <summary>Fetch the set of server-side time-log ids for a recent window and remove
    /// any local synced interval (and its cached thumbnail) whose id is no longer there —
    /// i.e. it was deleted from the web Work Diary. Best-effort: if the fetch fails we skip
    /// this tick rather than risk deleting local data on a transient error.</summary>
    private async Task ReconcileDeletionsAsync(CancellationToken ct)
    {
        try
        {
            var to = DateTimeOffset.UtcNow;
            string fromS = to.AddDays(-ReconcileWindowDays).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            string toS = to.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

            HashSet<string> serverIds;
            try
            {
                serverIds = await _api.GetTimeLogIdsAsync(fromS, toS, _auth.AccessToken, ct);
            }
            catch (ApiException ex) when (ex.StatusCode == 401)
            {
                if (!await _auth.RefreshAsync())
                    return;
                serverIds = await _api.GetTimeLogIdsAsync(fromS, toS, _auth.AccessToken, ct);
            }

            foreach (var (id, apiId, thumb) in _db.SyncedIntervalsInRange(fromS, toS))
            {
                if (serverIds.Contains(apiId))
                    continue; // still exists server-side
                // Deleted on the web → drop the local row + cached thumbnail.
                try
                {
                    if (!string.IsNullOrEmpty(thumb) && File.Exists(thumb))
                        File.Delete(thumb);
                }
                catch (Exception e) { Log.Warn($"reconcile thumb {id}: {e.Message}"); }
                _db.DeleteInterval(id);
                Log.Info($"reconcile: removed locally-deleted interval {id} (api {apiId})");
            }
        }
        catch (Exception e)
        {
            Log.Warn($"reconcile deletions: {e.Message}");
        }
    }

    /// <summary>Fetch the live policy and push it into <see cref="PolicyState"/>,
    /// refreshing the token once on 401. Runs on the sync loop's background thread.
    /// Failures are non-fatal — the policy simply isn't updated this tick.</summary>
    private async Task PollPolicyAsync(CancellationToken ct)
    {
        try
        {
            PolicyResult policy;
            try
            {
                policy = await _api.GetPolicyAsync(_auth.AccessToken, ct);
            }
            catch (ApiException ex) when (ex.StatusCode == 401)
            {
                if (!await _auth.RefreshAsync())
                    return; // refresh rejected (e.g. tracking disabled) → already logged out
                policy = await _api.GetPolicyAsync(_auth.AccessToken, ct);
            }
            _policy.Apply(policy.CanTrack, policy.AllowManualTime, ProjectsSignature(policy.Projects));
        }
        catch (Exception e)
        {
            Log.Warn($"policy poll: {e.Message}");
        }
    }

    /// <summary>Order-independent fingerprint of the assigned projects (id + name +
    /// rate), so the UI refreshes when an employer adds/removes/renames a project or
    /// changes its rate.</summary>
    private static string ProjectsSignature(System.Collections.Generic.List<Project> projects)
    {
        var parts = projects
            .Select(p => $"{p.Id}:{p.Name}:{p.HourlyRateCents}")
            .OrderBy(s => s, StringComparer.Ordinal);
        return string.Join("|", parts);
    }

    private void PruneUploadedScreenshots()
    {
        foreach (var (id, path) in _db.ScreenshotsToPrune())
        {
            try
            {
                if (File.Exists(path))
                    File.Delete(path);
                _db.ClearScreenshotPath(id);
            }
            catch (Exception e)
            {
                Log.Warn($"prune screenshot {id}: {e.Message}");
            }
        }
    }

    private static string Iso(DateTimeOffset t) =>
        t.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>Reads the "id" field whether the API returns it as a string or a number.</summary>
    private static string ExtractId(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.TryGetProperty("id", out var idEl))
        {
            return idEl.ValueKind == JsonValueKind.String
                ? idEl.GetString() ?? ""
                : idEl.GetRawText();
        }
        return "";
    }
}
