using System.Text.Json;

namespace TrayPoc.Services;

/// <summary>
/// Shared JSON settings. snake_case matches both the on-disk config files
/// (mirroring the original Rust TOML field names) and the Go API's JSON shape,
/// so the same DTOs serialize cleanly for config and for the API.
/// </summary>
public static class AppJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };
}
