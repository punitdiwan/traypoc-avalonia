using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>
/// Port of the Rust <c>tracker.rs</c> background loop: every ~interval (with
/// jitter) it captures a screenshot, samples activity, writes a row to SQLite,
/// and uploads to Spaces. Skips capture while idle, polling every 30s.
/// </summary>
public sealed class TrackerService
{
    private const int JitterPercent = 20;        // ±20% of the interval
    private const int FirstCaptureDelaySecs = 10;
    private const int IdlePollSecs = 30;

    private readonly Database _db;
    private readonly ConfigState _config;
    private readonly ActivityMonitor _activity;
    private readonly SpacesUploader _uploader;

    private volatile bool _running;
    private CancellationTokenSource? _cts;
    private readonly object _startLock = new();

    /// <summary>Set by the App to push the tray tooltip text.</summary>
    public Action<string>? SetTooltip { get; set; }

    /// <summary>Raised (on a thread-pool thread) when running state flips.</summary>
    public event Action? RunningChanged;

    public TrackerService(Database db, ConfigState config, ActivityMonitor activity, SpacesUploader uploader)
    {
        _db = db;
        _config = config;
        _activity = activity;
        _uploader = uploader;
    }

    public bool Running => _running;

    public void Start()
    {
        lock (_startLock)
        {
            if (_running)
                return;
            _running = true;
            _cts = new CancellationTokenSource();
            var ct = _cts.Token;
            _ = Task.Run(() => RunLoopAsync(ct));
        }
        RunningChanged?.Invoke();
    }

    public void Stop()
    {
        lock (_startLock)
        {
            if (!_running)
                return;
            _running = false;
            _cts?.Cancel();
        }
        RunningChanged?.Invoke();
    }

    public TrackerStatus Status()
    {
        var cfg = _config.Current;
        return new TrackerStatus
        {
            Running = _running,
            LastCapture = _db.LastCaptureTime(),
            IntervalsToday = _db.IntervalsTodayCount(),
            PendingUploads = _db.PendingUploadCount(),
            IsIdle = _activity.IsIdle(cfg.IdleThresholdSecs),
            IdleSecs = _activity.IdleSecs(),
        };
    }

    private async Task RunLoopAsync(CancellationToken ct)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(FirstCaptureDelaySecs), ct);

            while (_running && !ct.IsCancellationRequested)
            {
                var cfg = _config.Current;
                long idleThreshold = cfg.IdleThresholdSecs;
                long intervalSecs = Math.Max(10, cfg.CaptureIntervalSecs);

                if (_activity.IsIdle(idleThreshold))
                {
                    UpdateTooltip(intervalSecs, isIdle: true);
                    await Task.Delay(TimeSpan.FromSeconds(IdlePollSecs), ct);
                    continue;
                }

                try
                {
                    await CaptureAndUploadAsync(intervalSecs);
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine($"capture error: {e.Message}");
                }

                await _uploader.DrainQueueAsync(_config.Current);
                UpdateTooltip(intervalSecs, isIdle: false);

                if (!_running)
                    break;

                int jitterMax = (int)(intervalSecs * JitterPercent / 100.0);
                int jitter = jitterMax > 0 ? Random.Shared.Next(-jitterMax, jitterMax + 1) : 0;
                long next = Math.Max(10, intervalSecs + jitter);

                long slept = 0;
                while (slept < next && _running && !ct.IsCancellationRequested)
                {
                    long chunk = Math.Min(IdlePollSecs, next - slept);
                    await Task.Delay(TimeSpan.FromSeconds(chunk), ct);
                    slept += chunk;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Stop() requested — normal shutdown.
        }
    }

    private async Task CaptureAndUploadAsync(long intervalSecs)
    {
        var now = DateTimeOffset.UtcNow;
        string date = now.ToString("yyyy-MM-dd");
        string timestamp = now.ToString("yyyyMMdd_HHmmss");
        string startTime = now.ToString(Database.TimeFormat);

        string dir = Path.Combine(AppPaths.ScreenshotsDir, date);
        string png = Path.Combine(dir, $"{timestamp}.png");
        string thumb = Path.Combine(dir, $"{timestamp}_thumb.jpg");

        string? windowTitle = WindowTitle.GetActiveWindowTitle();
        double activityPct = _activity.TakePercent(intervalSecs);

        await Task.Run(() => ScreenshotService.Capture(png, thumb));

        long intervalId = _db.InsertInterval(startTime, png, thumb, activityPct, windowTitle);

        var cfg = _config.Current;
        string spacesKey = $"{cfg.UserId}/{date}/{timestamp}.png";
        _db.EnqueueUpload(intervalId, png, spacesKey);

        if (cfg.IsConfigured())
        {
            try
            {
                string url = await _uploader.UploadFileAsync(png, spacesKey, cfg);
                _db.MarkUploaded(intervalId, url);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"immediate upload failed, queued: {e.Message}");
            }

            string thumbKey = spacesKey.Replace(".png", "_thumb.jpg");
            try
            {
                await _uploader.UploadFileAsync(thumb, thumbKey, cfg);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"thumbnail spaces upload failed: {e.Message}");
            }
        }

        Console.WriteLine($"captured interval {intervalId} activity={activityPct:0}%");
    }

    private void UpdateTooltip(long intervalSecs, bool isIdle)
    {
        long count = _db.IntervalsTodayCount();
        double hours = count * intervalSecs / 3600.0;
        string suffix = isIdle ? " (idle)" : "";
        SetTooltip?.Invoke($"Time Tracker — {hours:0.0}h today{suffix}");
    }
}
