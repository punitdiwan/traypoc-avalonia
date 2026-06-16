using System;
using System.Globalization;
using System.IO;
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

    private readonly Database _db;
    private readonly AuthService _auth;
    private readonly ApiClient _api;
    private readonly ConfigState _config;

    private CancellationTokenSource? _cts;

    public SyncService(Database db, AuthService auth, ApiClient api, ConfigState config)
    {
        _db = db;
        _auth = auth;
        _api = api;
        _config = config;
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

        var pending = _db.PendingSyncIntervals();
        long duration = _config.Current.CaptureIntervalSecs;
        if (duration <= 0)
            duration = 600;

        foreach (var interval in pending)
        {
            if (interval.SpacesUrl is null)
                continue; // only sync intervals already uploaded to Spaces

            var ended = DateTimeOffset.Parse(interval.StartTime, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
            var started = ended.AddSeconds(-duration);

            var body = new TimeLogRequest
            {
                StartedAt = Iso(started),
                EndedAt = Iso(ended),
                DurationSeconds = duration,
                ActivityPercent = (int)Math.Round(interval.ActivityPercent),
                ScreenshotUrl = interval.SpacesUrl,
                ThumbnailUrl = interval.SpacesUrl.Replace(".png", "_thumb.jpg"),
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
