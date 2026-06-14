using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>
/// HTTP client for the Go API. Ports the fetch calls that lived in the React
/// frontend (api/auth.ts + useSyncLoop.ts), since in the original the frontend —
/// not Rust — talked to the API.
/// </summary>
public sealed class ApiClient
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    private readonly Func<AppConfig> _config;

    public ApiClient(Func<AppConfig> config) => _config = config;

    /// <summary>API base URL: config.api_url, else TIMETRACKER_API_URL env, else localhost:8080.</summary>
    public string ApiBase
    {
        get
        {
            var url = _config().ApiUrl;
            if (!string.IsNullOrWhiteSpace(url))
                return url.TrimEnd('/');
            return (Environment.GetEnvironmentVariable("TIMETRACKER_API_URL")
                ?? "http://localhost:8080").TrimEnd('/');
        }
    }

    public async Task<LoginResult> LoginAsync(string email, string password, CancellationToken ct = default)
    {
        using var resp = await Http.PostAsJsonAsync($"{ApiBase}/auth/login",
            new { email, password }, AppJson.Options, ct);
        if (!resp.IsSuccessStatusCode)
        {
            string text = (await resp.Content.ReadAsStringAsync(ct)).Trim();
            throw new InvalidOperationException(string.IsNullOrEmpty(text) ? "Login failed" : text);
        }
        return (await resp.Content.ReadFromJsonAsync<LoginResult>(AppJson.Options, ct))!;
    }

    public async Task<LoginResult> RefreshAsync(string refreshToken, CancellationToken ct = default)
    {
        using var resp = await Http.PostAsJsonAsync($"{ApiBase}/auth/refresh",
            new { refresh_token = refreshToken }, AppJson.Options, ct);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException("Session expired");
        return (await resp.Content.ReadFromJsonAsync<LoginResult>(AppJson.Options, ct))!;
    }

    /// <summary>POST one interval to /time-logs. Caller inspects the status (e.g. 401 → refresh).</summary>
    public Task<HttpResponseMessage> PostTimeLogAsync(TimeLogRequest body, string token, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, $"{ApiBase}/time-logs")
        {
            Content = new StringContent(JsonSerializer.Serialize(body, AppJson.Options),
                Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        return Http.SendAsync(req, ct);
    }

    public async Task<bool> DeleteAllTimeLogsAsync(string token, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Delete, $"{ApiBase}/time-logs");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var resp = await Http.SendAsync(req, ct);
        return resp.IsSuccessStatusCode || (int)resp.StatusCode == 204;
    }
}
