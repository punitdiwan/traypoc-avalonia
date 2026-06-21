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
    /// <summary>True for a manual-mode interval: no screenshot was captured, so it
    /// syncs without waiting on a Spaces upload and renders a "Manual" placeholder.</summary>
    public bool Manual { get; set; }
    /// <summary>Free-text notes the employee entered for this interval (what they
    /// were working on). Sent to the API and shown in the Work Diary lightbox.</summary>
    public string? Notes { get; set; }
    /// <summary>Process/application name of the active window when this interval was
    /// captured (e.g. "chrome", "Code", "WINWORD"). Sent to the API for categorization.</summary>
    public string? AppName { get; set; }
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
    /// <summary>True while tracking is running in manual mode (no screenshots) —
    /// drives the "Manual Tracking" status indicator.</summary>
    public bool Manual { get; set; }
    /// <summary>True when tracking was automatically stopped because the user exceeded
    /// the idle auto-pause threshold. Cleared when tracking resumes.</summary>
    public bool PausedByIdle { get; set; }
}
