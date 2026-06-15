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
    public string Role { get; set; } = "";
    public bool CanTrack { get; set; }
}

/// <summary>Request body for <c>POST /time-logs</c> (one captured interval).</summary>
public sealed class TimeLogRequest
{
    public string StartedAt { get; set; } = "";
    public string EndedAt { get; set; } = "";
    public long DurationSeconds { get; set; }
    public int ActivityPercent { get; set; }
    public string? ScreenshotUrl { get; set; }
    public string? ThumbnailUrl { get; set; }
    public string? WindowTitle { get; set; }
}

public sealed class TimeLogResponse
{
    public string Id { get; set; } = "";
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
