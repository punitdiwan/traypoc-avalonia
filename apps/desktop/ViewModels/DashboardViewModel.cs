using System;
using System.Collections.ObjectModel;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using TrayPoc.Models;
using TrayPoc.Services;

namespace TrayPoc.ViewModels;

/// <summary>Port of the React <c>Dashboard</c> page (status + recent screenshots).</summary>
public partial class DashboardViewModel : ViewModelBase
{
    private readonly AppServices _services;
    private DispatcherTimer? _timer;
    private int _tick;

    [ObservableProperty] private string _statusLabel = "Stopped";
    [ObservableProperty] private IBrush _statusBrush = Brushes.Gray;
    [ObservableProperty] private long _intervalsToday;
    [ObservableProperty] private string _hoursTracked = "0.0";
    [ObservableProperty] private long _pendingUploads;
    [ObservableProperty] private string? _lastCaptureText;
    [ObservableProperty] private bool _hasIntervals;

    // Project selection — the employee must pick a project before tracking.
    [ObservableProperty] private bool _hasProjects;
    [ObservableProperty] private Project? _selectedProject;

    // Manual (screenshot-less) time entry — only shown when the employer allows it.
    [ObservableProperty] private bool _allowManualTime;
    [ObservableProperty] private string _manualMinutes = "";
    [ObservableProperty] private string? _manualStatus;

    /// <summary>Continuous manual-tracking mode: when on, pressing Start records time
    /// without screenshots. Mirrors <see cref="TrackerService.ManualMode"/>.</summary>
    [ObservableProperty] private bool _manualMode;

    /// <summary>Free-text notes for the current/next captured interval. Auto-carried:
    /// persists until the employee changes it. Required before Start when the employer
    /// has set <see cref="RequireNotes"/>.</summary>
    [ObservableProperty] private string _workingNotes = "";

    /// <summary>True when the employer requires non-blank working notes on every
    /// captured interval — drives the asterisk hint and the "Notes required" tooltip.</summary>
    [ObservableProperty] private bool _requireNotes;

    public ObservableCollection<IntervalItemViewModel> Intervals { get; } = new();
    public ObservableCollection<Project> Projects { get; } = new();

    public DashboardViewModel(AppServices services)
    {
        _services = services;
        AllowManualTime = _services.Policy.AllowManualTime;
        RequireNotes = _services.Policy.RequireNotes;
        ManualMode = _services.Tracker.ManualMode;
        WorkingNotes = _services.Tracker.WorkingNotes;
        // The background policy poll may change manual-time permission or the set of
        // assigned projects (incl. rate edits) — react on the UI thread.
        _services.Policy.Changed += () => Dispatcher.UIThread.Post(OnPolicyChanged);
        // The tracker may clear manual mode itself (e.g. permission revoked) — keep
        // the toggle in sync.
        _services.Tracker.ManualModeChanged += () =>
            Dispatcher.UIThread.Post(() => ManualMode = _services.Tracker.ManualMode);
    }

    private void OnPolicyChanged()
    {
        AllowManualTime = _services.Policy.AllowManualTime;
        RequireNotes = _services.Policy.RequireNotes;
        ManualMode = _services.Tracker.ManualMode;
        _ = LoadProjectsAsync();
    }

    partial void OnManualModeChanged(bool value)
    {
        _services.Tracker.ManualMode = value;
        // The tracker refuses manual mode without employer permission — reflect the
        // real state back so the toggle can't get stuck on.
        if (ManualMode != _services.Tracker.ManualMode)
            ManualMode = _services.Tracker.ManualMode;
    }

    /// <summary>Log a manual time entry (no screenshot) for the selected project.
    /// Gated client-side by <see cref="AllowManualTime"/>; the API enforces it too.</summary>
    [RelayCommand]
    private async Task AddManualTimeAsync()
    {
        ManualStatus = null;
        if (!AllowManualTime)
        {
            ManualStatus = "Manual time isn't enabled for your account.";
            return;
        }
        if (SelectedProject is null)
        {
            ManualStatus = "Select a project first.";
            return;
        }
        if (!int.TryParse(ManualMinutes, out int minutes) || minutes <= 0)
        {
            ManualStatus = "Enter minutes greater than 0.";
            return;
        }

        var now = DateTimeOffset.UtcNow;
        var body = new TimeLogRequest
        {
            ProjectId = SelectedProject.Id,
            StartedAt = Iso(now.AddMinutes(-minutes)),
            EndedAt = Iso(now),
            DurationSeconds = minutes * 60L,
            ActivityPercent = 0,
            ScreenshotUrl = null,
            ThumbnailUrl = null,
            WindowTitle = "Manual entry",
            Notes = string.IsNullOrWhiteSpace(WorkingNotes) ? null : WorkingNotes.Trim(),
        };

        try
        {
            var resp = await _services.Api.PostTimeLogAsync(body, _services.Auth.AccessToken);
            if ((int)resp.StatusCode == 401)
            {
                resp.Dispose();
                if (await _services.Auth.RefreshAsync())
                    resp = await _services.Api.PostTimeLogAsync(body, _services.Auth.AccessToken);
            }
            if (resp.IsSuccessStatusCode)
            {
                ManualStatus = $"Added {minutes} min of manual time.";
                ManualMinutes = "";
                await RefreshIntervalsAsync();
            }
            else
            {
                string text = (await resp.Content.ReadAsStringAsync()).Trim();
                ManualStatus = string.IsNullOrEmpty(text) ? "Failed to add manual time." : text;
            }
            resp.Dispose();
        }
        catch (Exception e)
        {
            ManualStatus = e.Message;
            Log.Warn($"manual time: {e.Message}");
        }
    }

    private static string Iso(DateTimeOffset t) =>
        t.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    partial void OnSelectedProjectChanged(Project? value)
    {
        _services.Tracker.SelectedProjectId = value?.Id;
        _services.Config.SetSelectedProjectId(value?.Id ?? "");
    }

    partial void OnWorkingNotesChanged(string value)
    {
        _services.Tracker.WorkingNotes = value;
    }

    private async Task LoadProjectsAsync()
    {
        if (!_services.Auth.IsAuthenticated)
            return;
        try
        {
            var list = await _services.Api.GetProjectsAsync(_services.Auth.AccessToken);
            var savedId = _services.Config.Current.SelectedProjectId;
            Projects.Clear();
            foreach (var p in list)
                Projects.Add(p);
            HasProjects = Projects.Count > 0;
            // Restore the previously-selected project if it's still assigned.
            SelectedProject = Projects.FirstOrDefault(p => p.Id == savedId);
        }
        catch (Exception e)
        {
            Log.Warn($"load projects: {e.Message}");
        }
    }

    /// <summary>Begin periodic refresh (called when the main UI becomes visible).</summary>
    public void Activate()
    {
        if (_timer is not null)
            return;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _timer.Tick += async (_, _) =>
        {
            await RefreshStatusAsync();
            if (_tick++ % 3 == 0)
                await RefreshIntervalsAsync();
        };
        _timer.Start();
        _ = RefreshStatusAsync();
        _ = RefreshIntervalsAsync();
        _ = LoadProjectsAsync();
    }

    private async Task RefreshStatusAsync()
    {
        var status = await Task.Run(() => _services.Tracker.Status());
        long intervalSecs = _services.Config.Current.CaptureIntervalSecs;

        StatusLabel = !status.Running
            ? (status.PausedByIdle ? "Auto-paused (idle)" : "Stopped")
            : status.Manual ? "Manual Tracking"
            : status.IsIdle ? "Idle"
            : "Tracking";
        StatusBrush = !status.Running
            ? (status.PausedByIdle
                ? new SolidColorBrush(Color.Parse("#facc15"))  // yellow: auto-paused by idle
                : new SolidColorBrush(Color.Parse("#f87171"))) // red: manually stopped
            : status.Manual || status.IsIdle
                ? new SolidColorBrush(Color.Parse("#facc15"))  // yellow: manual or skipping idle
                : new SolidColorBrush(Color.Parse("#4ade80")); // green: actively tracking

        IntervalsToday = status.IntervalsToday;
        PendingUploads = status.PendingUploads;
        HoursTracked = (status.IntervalsToday * intervalSecs / 3600.0)
            .ToString("0.0", CultureInfo.InvariantCulture);
        LastCaptureText = FormatLocalTime(status.LastCapture);
    }

    private async Task RefreshIntervalsAsync()
    {
        string today = DateTime.UtcNow.ToString("yyyy-MM-dd");
        var rows = await Task.Run(() => _services.Db.GetIntervalsForDate(today));

        Intervals.Clear();
        foreach (var row in rows)
            Intervals.Add(new IntervalItemViewModel(row));
        HasIntervals = Intervals.Count > 0;
    }

    private static string? FormatLocalTime(string? iso)
    {
        if (string.IsNullOrEmpty(iso))
            return null;
        if (DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dto))
            return "Last capture: " + dto.ToLocalTime().ToString("t", CultureInfo.CurrentCulture);
        return null;
    }
}

/// <summary>One row in the recent-screenshots list.</summary>
public sealed class IntervalItemViewModel
{
    public string TimeText { get; }
    public string WindowTitle { get; }
    public string ActivityText { get; }
    public string UploadText { get; }
    public IBrush UploadBrush { get; }
    public bool Unsynced { get; }
    public Bitmap? Thumb { get; }

    public IntervalItemViewModel(TimeInterval row)
    {
        TimeText = ParseLocal(row.StartTime);
        WindowTitle = string.IsNullOrEmpty(row.WindowTitle) ? "Unknown window" : row.WindowTitle!;
        ActivityText = row.Manual ? "Manual entry" : $"Activity: {Math.Round(row.ActivityPercent)}%";
        bool uploaded = row.SpacesUrl is not null;
        // Manual intervals have no screenshot to upload — don't show "Pending upload".
        UploadText = row.Manual ? "Manual" : uploaded ? "Uploaded" : "Pending upload";
        UploadBrush = new SolidColorBrush(Color.Parse(
            row.Manual ? "#9ca3af" : uploaded ? "#22c55e" : "#eab308"));
        Unsynced = !row.Synced;
        Thumb = LoadThumb(row.ThumbPath);
    }

    private static Bitmap? LoadThumb(string? path)
    {
        try
        {
            return string.IsNullOrEmpty(path) || !File.Exists(path) ? null : new Bitmap(path);
        }
        catch
        {
            return null;
        }
    }

    private static string ParseLocal(string iso)
    {
        return DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dto)
            ? dto.ToLocalTime().ToString("t", CultureInfo.CurrentCulture)
            : iso;
    }
}
