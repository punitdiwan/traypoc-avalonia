using System;
using System.Collections.ObjectModel;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
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

    public ObservableCollection<IntervalItemViewModel> Intervals { get; } = new();

    public DashboardViewModel(AppServices services) => _services = services;

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
    }

    private async Task RefreshStatusAsync()
    {
        var status = await Task.Run(() => _services.Tracker.Status());
        long intervalSecs = _services.Config.Current.CaptureIntervalSecs;

        StatusLabel = !status.Running ? "Stopped" : status.IsIdle ? "Idle" : "Tracking";
        StatusBrush = !status.Running
            ? new SolidColorBrush(Color.Parse("#f87171"))   // red
            : status.IsIdle
                ? new SolidColorBrush(Color.Parse("#facc15")) // yellow
                : new SolidColorBrush(Color.Parse("#4ade80")); // green

        IntervalsToday = status.IntervalsToday;
        PendingUploads = status.PendingUploads;
        HoursTracked = (status.IntervalsToday * intervalSecs / 3600.0)
            .ToString("0.0", CultureInfo.InvariantCulture);
        LastCaptureText = FormatLocalTime(status.LastCapture);
    }

    private async Task RefreshIntervalsAsync()
    {
        var rows = await Task.Run(() => _services.Db.RecentIntervals(20));

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
        ActivityText = $"Activity: {Math.Round(row.ActivityPercent)}%";
        bool uploaded = row.SpacesUrl is not null;
        UploadText = uploaded ? "Uploaded" : "Pending upload";
        UploadBrush = new SolidColorBrush(Color.Parse(uploaded ? "#22c55e" : "#eab308"));
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
