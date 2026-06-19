namespace TrayPoc.Models;

/// <summary>
/// App configuration: server URL + tracker tuning. DO Spaces credentials are no
/// longer stored here — uploads use presigned URLs minted by the API server.
/// <c>api_url</c> and <c>user_id</c> are managed by auth, not shown in the UI.
/// </summary>
public sealed class AppConfig
{
    public string ApiUrl { get; set; } = "";
    public string UserId { get; set; } = "";

    /// <summary>The project the employee selected to track against. Persisted so the
    /// picker restores the last choice across restarts.</summary>
    public string SelectedProjectId { get; set; } = "";

    /// <summary>Seconds between captures. Default 600 (10 min). Minimum 10.</summary>
    public long CaptureIntervalSecs { get; set; } = 600;

    /// <summary>Seconds of no input before considered idle. Default 300 (5 min).</summary>
    public long IdleThresholdSecs { get; set; } = 300;

    public AppConfig Clone() => (AppConfig)MemberwiseClone();
}

/// <summary>Port of the Rust <c>AuthConfig</c>: tokens + identity, written on login.</summary>
public sealed class AuthConfig
{
    public string AccessToken { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public string UserId { get; set; } = "";
    public string UserEmail { get; set; } = "";
    public string UserName { get; set; } = "";
    public string UserRole { get; set; } = "";

    public bool IsAuthenticated() =>
        !string.IsNullOrEmpty(AccessToken) && !string.IsNullOrEmpty(UserId);
}
