namespace TrayPoc.Models;

/// <summary>Port of the Rust <c>IntervalRow</c> / TS <c>TimeInterval</c>.</summary>
public sealed class TimeInterval
{
    public long Id { get; set; }
    public string StartTime { get; set; } = "";
    public string? EndTime { get; set; }
    public string? ScreenshotPath { get; set; }
    public string? ThumbPath { get; set; }
    public string? SpacesUrl { get; set; }
    public double ActivityPercent { get; set; }
    public string? WindowTitle { get; set; }
    public string? ProjectId { get; set; }
    public bool Synced { get; set; }
}

/// <summary>Port of the Rust <c>TrackerStatus</c>.</summary>
public sealed class TrackerStatus
{
    public bool Running { get; set; }
    public string? LastCapture { get; set; }
    public long IntervalsToday { get; set; }
    public long PendingUploads { get; set; }
    public bool IsIdle { get; set; }
    public long? IdleSecs { get; set; }
}
