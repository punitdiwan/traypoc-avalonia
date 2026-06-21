using System.Collections.Generic;

namespace TrayPoc.Models;

/// <summary>Response body of <c>POST /auth/login</c> and <c>/auth/refresh</c>.</summary>
public sealed class LoginResult
{
    public string AccessToken { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public ApiUser User { get; set; } = new();
}

public sealed class ApiUser
{
    public string Id { get; set; } = "";
    public string Email { get; set; } = "";
    public string FullName { get; set; } = "";
    public string Role { get; set; } = "";
    public bool CanTrack { get; set; }
    public string OrgName { get; set; } = "";
}

/// <summary>Request body for <c>POST /time-logs</c> (one captured interval).</summary>
public sealed class TimeLogRequest
{
    public string? ProjectId { get; set; }
    public string StartedAt { get; set; } = "";
    public string EndedAt { get; set; } = "";
    public long DurationSeconds { get; set; }
    public int ActivityPercent { get; set; }
    public string? ScreenshotUrl { get; set; }
    public string? ThumbnailUrl { get; set; }
    public string? WindowTitle { get; set; }
    public string? AppName { get; set; }
    public string? Notes { get; set; }
}

/// <summary>A project the employee is assigned to (from <c>GET /projects</c>).</summary>
public sealed class Project
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>Project billable rate (cents/hour); 0 when unset. Tracked so a rate
    /// change polled via the policy endpoint is detectable, even if not displayed.</summary>
    public int HourlyRateCents { get; set; }
}

/// <summary>Response body of <c>GET /me/policy</c>: the live employer policy the
/// desktop polls so it reacts to changes without a re-login.</summary>
public sealed class PolicyResult
{
    public bool CanTrack { get; set; }
    public bool AllowManualTime { get; set; }
    /// <summary>When true, the employee must provide non-empty working notes on
    /// every interval. Enforced server-side; gated client-side for fast feedback.</summary>
    public bool RequireNotes { get; set; }
    public List<Project> Projects { get; set; } = new();
}

public sealed class TimeLogResponse
{
    public string Id { get; set; } = "";
}

/// <summary>Response body of <c>GET /time-logs/ids</c>: the server-side ids of the
/// caller's time logs in a window, used to reconcile web-side deletions.</summary>
public sealed class TimeLogIdsResult
{
    public List<string> Ids { get; set; } = new();
}

/// <summary>One presigned upload slot returned by <c>POST /uploads/presign</c>.</summary>
public sealed class PresignedUpload
{
    public string Key { get; set; } = "";
    public string PutUrl { get; set; } = "";
    public string PublicUrl { get; set; } = "";
    /// <summary>Headers that must be sent on the PUT (signed): x-amz-acl, Content-Type.</summary>
    public Dictionary<string, string> Headers { get; set; } = new();
}

public sealed class PresignResponse
{
    public List<PresignedUpload> Uploads { get; set; } = new();
}
