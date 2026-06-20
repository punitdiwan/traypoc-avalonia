using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>An API call returned a non-success HTTP status. Carries the code so
/// callers can react (e.g. refresh + retry on 401).</summary>
public sealed class ApiException : Exception
{
    public int StatusCode { get; }
    public ApiException(int statusCode, string message) : base(message) => StatusCode = statusCode;
}

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

    /// <summary>POST one interval to /time-logs. Caller inspects the status (e.g. 401 → refresh).
    /// Transient failures (network/5xx) are retried with backoff before returning.</summary>
    public Task<HttpResponseMessage> PostTimeLogAsync(TimeLogRequest body, string token, CancellationToken ct = default)
    {
        string json = JsonSerializer.Serialize(body, AppJson.Options);
        return HttpResilience.SendAsync(async c =>
        {
            var req = new HttpRequestMessage(HttpMethod.Post, $"{ApiBase}/time-logs")
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return await Http.SendAsync(req, c);
        }, ct).AsTask();
    }

    /// <summary>Request presigned PUT URLs for one or more object keys (each a path
    /// under the caller's own user prefix, e.g. "2026-06-15/shot.png").</summary>
    public async Task<List<PresignedUpload>> PresignUploadsAsync(
        IReadOnlyList<(string Key, string ContentType)> files, string token, CancellationToken ct = default)
    {
        var body = new
        {
            files = files.Select(f => new { key = f.Key, content_type = f.ContentType }).ToArray(),
        };
        string json = JsonSerializer.Serialize(body);
        using var resp = await HttpResilience.SendAsync(async c =>
        {
            var req = new HttpRequestMessage(HttpMethod.Post, $"{ApiBase}/uploads/presign")
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return await Http.SendAsync(req, c);
        }, ct);
        if (!resp.IsSuccessStatusCode)
        {
            string text = (await resp.Content.ReadAsStringAsync(ct)).Trim();
            throw new ApiException((int)resp.StatusCode,
                string.IsNullOrEmpty(text) ? "presign failed" : text);
        }
        var parsed = await resp.Content.ReadFromJsonAsync<PresignResponse>(AppJson.Options, ct);
        return parsed?.Uploads ?? new List<PresignedUpload>();
    }

    /// <summary>Fetch the projects the authenticated employee is assigned to.</summary>
    public async Task<List<Project>> GetProjectsAsync(string token, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, $"{ApiBase}/projects");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var resp = await Http.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            string text = (await resp.Content.ReadAsStringAsync(ct)).Trim();
            throw new ApiException((int)resp.StatusCode,
                string.IsNullOrEmpty(text) ? "failed to load projects" : text);
        }
        return (await resp.Content.ReadFromJsonAsync<List<Project>>(AppJson.Options, ct))
            ?? new List<Project>();
    }

    /// <summary>Fetch the live policy snapshot (can_track, allow_manual_time, projects).
    /// Polled off the UI thread by <see cref="SyncService"/>. 401 is surfaced as an
    /// <see cref="ApiException"/> so the caller can refresh + retry.</summary>
    public async Task<PolicyResult> GetPolicyAsync(string token, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, $"{ApiBase}/me/policy");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var resp = await Http.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            string text = (await resp.Content.ReadAsStringAsync(ct)).Trim();
            throw new ApiException((int)resp.StatusCode,
                string.IsNullOrEmpty(text) ? "failed to load policy" : text);
        }
        return (await resp.Content.ReadFromJsonAsync<PolicyResult>(AppJson.Options, ct))
            ?? new PolicyResult();
    }

    /// <summary>Change the authenticated user's own password. Throws <see cref="ApiException"/>
    /// if the current password is wrong (401) or validation fails (400).</summary>
    public async Task ChangePasswordAsync(string token, string currentPassword, string newPassword, CancellationToken ct = default)
    {
        string json = JsonSerializer.Serialize(
            new { current_password = currentPassword, new_password = newPassword }, AppJson.Options);
        var req = new HttpRequestMessage(HttpMethod.Patch, $"{ApiBase}/auth/password")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var resp = await Http.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            string text = (await resp.Content.ReadAsStringAsync(ct)).Trim();
            throw new ApiException((int)resp.StatusCode,
                string.IsNullOrEmpty(text) ? "failed to change password" : text);
        }
    }

    /// <summary>Update the authenticated user's own full name via PATCH /auth/me.</summary>
    public async Task UpdateMeAsync(string token, string fullName, CancellationToken ct = default)
    {
        string json = JsonSerializer.Serialize(new { full_name = fullName }, AppJson.Options);
        var req = new HttpRequestMessage(HttpMethod.Patch, $"{ApiBase}/auth/me")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var resp = await Http.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            string text = (await resp.Content.ReadAsStringAsync(ct)).Trim();
            throw new ApiException((int)resp.StatusCode,
                string.IsNullOrEmpty(text) ? "failed to update name" : text);
        }
    }

    /// <summary>Fetch the ids of the caller's server-side time logs whose start date is
    /// in [from,to] (yyyy-MM-dd). Used to reconcile deletions made on the web: any local
    /// synced interval missing from this set was deleted server-side. 401 surfaces as an
    /// <see cref="ApiException"/> so the caller can refresh + retry.</summary>
    public async Task<HashSet<string>> GetTimeLogIdsAsync(string from, string to, string token, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, $"{ApiBase}/time-logs/ids?from={from}&to={to}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var resp = await Http.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            string text = (await resp.Content.ReadAsStringAsync(ct)).Trim();
            throw new ApiException((int)resp.StatusCode,
                string.IsNullOrEmpty(text) ? "failed to load time-log ids" : text);
        }
        var parsed = await resp.Content.ReadFromJsonAsync<TimeLogIdsResult>(AppJson.Options, ct);
        return new HashSet<string>(parsed?.Ids ?? new List<string>(), StringComparer.OrdinalIgnoreCase);
    }

    public async Task<bool> DeleteAllTimeLogsAsync(string token, CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Delete, $"{ApiBase}/time-logs");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var resp = await Http.SendAsync(req, ct);
        return resp.IsSuccessStatusCode || (int)resp.StatusCode == 204;
    }
}
