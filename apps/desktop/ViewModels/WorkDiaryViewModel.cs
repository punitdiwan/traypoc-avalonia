using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using TrayPoc.Models;
using TrayPoc.Services;

namespace TrayPoc.ViewModels;

/// <summary>Port of the React <c>WorkDiary</c> page: date nav + hourly timeline + screenshot modal.</summary>
public partial class WorkDiaryViewModel : ViewModelBase
{
    private readonly AppServices _services;
    private Avalonia.Threading.DispatcherTimer? _timer;
    private DateOnly _date = DateOnly.FromDateTime(DateTime.Now);

    [ObservableProperty] private string _dateLabel = "Today";
    [ObservableProperty] private bool _isToday = true;
    [ObservableProperty] private bool _canGoNext;
    [ObservableProperty] private bool _isLoading;
    [ObservableProperty] private bool _hasData;

    [ObservableProperty] private int _captures;
    [ObservableProperty] private string _avgActivity = "0%";
    [ObservableProperty] private int _activeHours;

    // Screenshot modal
    [ObservableProperty] private bool _isModalOpen;
    [ObservableProperty] private bool _isModalManual;
    [ObservableProperty] private Bitmap? _modalImage;
    [ObservableProperty] private string? _modalTitle;
    [ObservableProperty] private string? _modalSubtitle;
    [ObservableProperty] private string? _modalSpacesUrl;

    public ObservableCollection<HourGroupViewModel> Hours { get; } = new();

    public WorkDiaryViewModel(AppServices services) => _services = services;

    /// <summary>Begin viewing (loads current date, refreshes today every 30s).</summary>
    public void Activate()
    {
        if (_timer is null)
        {
            _timer = new Avalonia.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
            _timer.Tick += (_, _) => { if (IsToday) _ = ReloadAsync(); };
            _timer.Start();
        }
        UpdateDateState();
        _ = ReloadAsync();
    }

    private void UpdateDateState()
    {
        var today = DateOnly.FromDateTime(DateTime.Now);
        IsToday = _date == today;
        CanGoNext = _date < today;
        DateLabel = IsToday
            ? "Today"
            : _date.ToDateTime(TimeOnly.MinValue).ToString("ddd, MMM d", CultureInfo.CurrentCulture);
    }

    private async Task ReloadAsync()
    {
        IsLoading = true;
        string ds = _date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var rows = await Task.Run(() => _services.Db.GetIntervalsForDate(ds));

        Hours.Clear();
        var byHour = new SortedDictionary<int, List<TimeInterval>>();
        foreach (var row in rows)
        {
            int hour = ToLocal(row.StartTime)?.Hour ?? 0;
            if (!byHour.TryGetValue(hour, out var list))
                byHour[hour] = list = new List<TimeInterval>();
            list.Add(row);
        }

        int activeHours = 0;
        foreach (var (hour, list) in byHour.Select(kv => (kv.Key, kv.Value)))
        {
            double avg = list.Average(i => i.ActivityPercent);
            if (avg > 0) activeHours++;
            Hours.Add(new HourGroupViewModel(hour, avg, list, SelectThumbCommand));
        }

        Captures = rows.Count;
        AvgActivity = rows.Count > 0
            ? $"{(int)Math.Round(rows.Average(i => i.ActivityPercent))}%"
            : "0%";
        ActiveHours = activeHours;
        HasData = rows.Count > 0;
        IsLoading = false;
    }

    [RelayCommand]
    private void PrevDay()
    {
        _date = _date.AddDays(-1);
        UpdateDateState();
        _ = ReloadAsync();
    }

    [RelayCommand]
    private void NextDay()
    {
        if (_date >= DateOnly.FromDateTime(DateTime.Now))
            return;
        _date = _date.AddDays(1);
        UpdateDateState();
        _ = ReloadAsync();
    }

    [RelayCommand]
    private void GoToday()
    {
        _date = DateOnly.FromDateTime(DateTime.Now);
        UpdateDateState();
        _ = ReloadAsync();
    }

    [RelayCommand]
    private void SelectThumb(DiaryThumbViewModel? thumb)
    {
        if (thumb is null)
            return;
        var iv = thumb.Interval;
        IsModalManual = iv.Manual;
        // Prefer the full screenshot; fall back to the thumbnail.
        ModalImage = LoadBitmap(File.Exists(iv.ScreenshotPath) ? iv.ScreenshotPath : iv.ThumbPath);
        var local = ToLocal(iv.StartTime);
        ModalTitle = local?.ToString("g", CultureInfo.CurrentCulture) ?? iv.StartTime;
        string title = string.IsNullOrEmpty(iv.WindowTitle) ? "Unknown window" : iv.WindowTitle!;
        ModalSubtitle = $"{title} — Activity {Math.Round(iv.ActivityPercent)}%";
        ModalSpacesUrl = iv.SpacesUrl;
        IsModalOpen = true;
    }

    [RelayCommand]
    private void CloseModal()
    {
        IsModalOpen = false;
        ModalImage = null;
    }

    internal static DateTimeOffset? ToLocal(string iso) =>
        DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dto)
            ? dto.ToLocalTime()
            : null;

    internal static Bitmap? LoadBitmap(string? path)
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
}

/// <summary>One hour bucket: an activity bar + a strip of thumbnails.</summary>
public sealed class HourGroupViewModel
{
    public string HourLabel { get; }
    public int ActivityPercent { get; }
    public IBrush BarBrush { get; }
    public ObservableCollection<DiaryThumbViewModel> Thumbs { get; } = new();

    public HourGroupViewModel(int hour, double avgActivity, List<TimeInterval> intervals, IRelayCommand selectCommand)
    {
        HourLabel = FormatHour(hour);
        ActivityPercent = (int)Math.Round(avgActivity);
        BarBrush = ActivityColor(avgActivity);
        foreach (var iv in intervals)
            Thumbs.Add(new DiaryThumbViewModel(iv, selectCommand));
    }

    private static string FormatHour(int h) => h switch
    {
        0 => "12:00 AM",
        < 12 => $"{h}:00 AM",
        12 => "12:00 PM",
        _ => $"{h - 12}:00 PM",
    };

    private static IBrush ActivityColor(double pct) => new SolidColorBrush(Color.Parse(
        pct >= 70 ? "#22c55e" :
        pct >= 40 ? "#eab308" :
        pct > 0 ? "#f97316" :
        "#374151"));
}

/// <summary>A single thumbnail chip in the hourly strip.</summary>
public sealed class DiaryThumbViewModel
{
    public Bitmap? Thumb { get; }
    public string TimeText { get; }
    public string Tooltip { get; }
    public TimeInterval Interval { get; }
    public IRelayCommand SelectCommand { get; }
    /// <summary>Manual-mode interval (no screenshot) → show a "Manual" placeholder.</summary>
    public bool IsManual { get; }
    /// <summary>Whether a real thumbnail image is available to render.</summary>
    public bool HasThumb => Thumb is not null;

    public DiaryThumbViewModel(TimeInterval interval, IRelayCommand selectCommand)
    {
        Interval = interval;
        SelectCommand = selectCommand;
        Thumb = WorkDiaryViewModel.LoadBitmap(interval.ThumbPath);
        IsManual = interval.Manual;
        var local = WorkDiaryViewModel.ToLocal(interval.StartTime);
        TimeText = local?.ToString("t", CultureInfo.CurrentCulture) ?? "";
        string title = string.IsNullOrEmpty(interval.WindowTitle) ? "unknown" : interval.WindowTitle!;
        Tooltip = $"{TimeText} — {title}\nActivity: {Math.Round(interval.ActivityPercent)}%";
    }
}
