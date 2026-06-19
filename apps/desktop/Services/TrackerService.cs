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
    private readonly AuthService _auth;
    private readonly PolicyState _policy;

    private volatile bool _running;
    // True while the employer has paused tracking and we were running — so we know
    // to auto-resume when they re-enable it. Cleared by any explicit Stop().
    private volatile bool _pausedByPolicy;
    private CancellationTokenSource? _cts;
    private readonly object _startLock = new();

    /// <summary>Set by the App to push the tray tooltip text.</summary>
    public Action<string>? SetTooltip { get; set; }

    /// <summary>Raised (on a thread-pool thread) when running state flips.</summary>
    public event Action? RunningChanged;

    /// <summary>Raised when the selected project changes (drives the Start gate).</summary>
    public event Action? SelectedProjectChanged;

    /// <summary>Raised when manual mode is toggled (drives the Start gate + status).</summary>
    public event Action? ManualModeChanged;

    private volatile string? _selectedProjectId;
    private volatile bool _manualMode;

    /// <summary>When true, tracking runs without screenshots: each interval logs time
    /// against the selected project with a "Manual entry" marker and no capture. Only
    /// usable while the employer allows manual time (<see cref="PolicyState.AllowManualTime"/>).</summary>
    public bool ManualMode
    {
        get => _manualMode;
        set
        {
            // Never enable manual mode the employer hasn't permitted.
            bool target = value && _policy.AllowManualTime;
            if (_manualMode == target)
                return;
            _manualMode = target;
            ManualModeChanged?.Invoke();
        }
    }

    /// <summary>The project new intervals are tracked against. Tracking cannot start
    /// until this is set (the employee must pick a project first).</summary>
    public string? SelectedProjectId
    {
        get => _selectedProjectId;
        set
        {
            _selectedProjectId = string.IsNullOrEmpty(value) ? null : value;
            SelectedProjectChanged?.Invoke();
        }
    }

    /// <summary>True when a project is selected and the employer allows tracking, so
    /// tracking is allowed to start. Manual mode additionally requires the employer
    /// to permit manual (screenshot-less) time.</summary>
    public bool CanStart => !string.IsNullOrEmpty(_selectedProjectId) && _policy.CanTrack
        && (!_manualMode || _policy.AllowManualTime);

    public TrackerService(Database db, ConfigState config, ActivityMonitor activity, SpacesUploader uploader, AuthService auth, PolicyState policy)
    {
        _db = db;
        _config = config;
        _activity = activity;
        _uploader = uploader;
        _auth = auth;
        _policy = policy;
        _policy.Changed += OnPolicyChanged;
    }

    /// <summary>React to a polled policy change (background thread). can_track is a
    /// live, reversible switch: when the employer pauses tracking we stop but
    /// remember we were running, and when they re-enable it we resume automatically
    /// so a brief pause loses no time. A pause never ends the session.</summary>
    private void OnPolicyChanged()
    {
        // Employer revoked manual-time permission: leave manual mode and stop any
        // in-progress manual capture (those intervals would now be rejected anyway).
        if (_manualMode && !_policy.AllowManualTime)
        {
            ManualMode = false; // fires ManualModeChanged so the UI toggle clears
            if (_running)
                Stop();
        }

        if (!_policy.CanTrack)
        {
            if (_running)
            {
                _pausedByPolicy = true;
                StopInternal();
            }
        }
        else if (_pausedByPolicy)
        {
            _pausedByPolicy = false;
            Start(); // guarded by CanStart (project selected + can_track [+ manual perm])
        }
    }

    public bool Running => _running;

    public void Start()
    {
        lock (_startLock)
        {
            if (_running)
                return;
            // A project must be selected before any time is tracked, the employer
            // must currently allow tracking, and manual mode needs manual permission.
            if (!CanStart)
                return;
            _running = true;
            _cts = new CancellationTokenSource();
            var ct = _cts.Token;
            _ = Task.Run(() => RunLoopAsync(ct));
        }
        RunningChanged?.Invoke();
    }

    /// <summary>Explicit stop — user toggle, logout, or shutdown. Clears any
    /// policy-pause resume intent so it won't auto-resume after a deliberate stop.</summary>
    public void Stop()
    {
        _pausedByPolicy = false;
        StopInternal();
    }

    private void StopInternal()
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
            Manual = _running && _manualMode,
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

                // Manual mode logs time regardless of idle (the employee is asserting
                // work without screenshots); automatic mode skips capture while idle.
                if (!_manualMode && _activity.IsIdle(idleThreshold))
                {
                    UpdateTooltip(intervalSecs, isIdle: true);
                    await Task.Delay(TimeSpan.FromSeconds(IdlePollSecs), ct);
                    continue;
                }

                try
                {
                    if (_manualMode)
                        LogManualInterval();
                    else
                        await CaptureAndUploadAsync(intervalSecs);
                }
                catch (Exception e)
                {
                    Log.Error($"capture: {e.Message}");
                }

                await _uploader.DrainQueueAsync(ct);
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

        long intervalId = _db.InsertInterval(startTime, png, thumb, activityPct, windowTitle, _selectedProjectId);

        // Keys are relative to the user's prefix; the API prepends the user id when
        // it mints the presigned URL, so no Spaces credentials live on the client.
        string spacesKey = $"{date}/{timestamp}.png";
        _db.EnqueueUpload(intervalId, png, spacesKey);

        if (_auth.IsAuthenticated)
        {
            try
            {
                string url = await _uploader.UploadFileAsync(png, spacesKey);
                _db.MarkUploaded(intervalId, url);
            }
            catch (Exception e)
            {
                Log.Warn($"immediate upload failed, queued: {e.Message}");
            }

            string thumbKey = $"{date}/{timestamp}_thumb.jpg";
            try
            {
                await _uploader.UploadFileAsync(thumb, thumbKey);
            }
            catch (Exception e)
            {
                Log.Warn($"thumbnail upload failed: {e.Message}");
            }
        }

        Log.Info($"captured interval {intervalId} activity={activityPct:0}%");
    }

    /// <summary>Manual-mode tick: record a screenshot-less interval against the
    /// selected project. No capture, no upload — <see cref="SyncService"/> pushes it
    /// straight to the API (which accepts it because manual time is permitted).</summary>
    private void LogManualInterval()
    {
        string startTime = DateTimeOffset.UtcNow.ToString(Database.TimeFormat);
        long intervalId = _db.InsertInterval(startTime, null, null, 0, "Manual entry",
            _selectedProjectId, manual: true);
        Log.Info($"logged manual interval {intervalId}");
    }

    private void UpdateTooltip(long intervalSecs, bool isIdle)
    {
        long count = _db.IntervalsTodayCount();
        double hours = count * intervalSecs / 3600.0;
        string suffix = isIdle ? " (idle)" : "";
        SetTooltip?.Invoke($"Time Tracker — {hours:0.0}h today{suffix}");
    }
}
