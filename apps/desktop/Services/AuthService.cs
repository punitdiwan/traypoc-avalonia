using System;
using System.Threading.Tasks;
using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>
/// Holds the authentication session and persists it — a merge of the Rust
/// auth commands and the React auth store. Raises <see cref="AuthChanged"/> so
/// the UI can switch between the Login screen and the main shell.
/// </summary>
public sealed class AuthService
{
    private readonly ApiClient _api;
    private readonly ConfigState _config;
    private AuthConfig _auth = new();

    public AuthService(ApiClient api, ConfigState config)
    {
        _api = api;
        _config = config;
    }

    public event Action? AuthChanged;

    public bool IsAuthenticated => _auth.IsAuthenticated();
    public string AccessToken => _auth.AccessToken;
    public string RefreshToken => _auth.RefreshToken;
    public string UserId => _auth.UserId;
    public string UserEmail => _auth.UserEmail;
    public string UserName => _auth.UserName;
    public string UserRole => _auth.UserRole;
    public string OrgName => _auth.OrgName;

    /// <summary>Load any persisted session from disk.</summary>
    public void Initialize() => _auth = ConfigStore.LoadAuth();

    public async Task LoginAsync(string email, string password)
    {
        var result = await _api.LoginAsync(email, password);
        ApplyResult(result);
        AuthChanged?.Invoke();
    }

    public void Logout()
    {
        ConfigStore.ClearAuth();
        _auth = new AuthConfig();
        _config.SetUserId("");
        AuthChanged?.Invoke();
    }

    /// <summary>Silently refresh the access token. Returns false if the session has fully expired.</summary>
    public async Task<bool> RefreshAsync()
    {
        if (string.IsNullOrEmpty(_auth.RefreshToken))
            return false;
        try
        {
            var result = await _api.RefreshAsync(_auth.RefreshToken);
            ApplyResult(result);
            return true;
        }
        catch
        {
            _auth = new AuthConfig();
            AuthChanged?.Invoke();
            return false;
        }
    }

    /// <summary>Update the signed-in user's own full name via the API and persist it.</summary>
    public async Task UpdateNameAsync(string fullName)
    {
        await _api.UpdateMeAsync(_auth.AccessToken, fullName);
        _auth.UserName = fullName;
        ConfigStore.SaveAuth(_auth);
        AuthChanged?.Invoke();
    }

    private void ApplyResult(LoginResult result)
    {
        _auth = new AuthConfig
        {
            AccessToken = result.AccessToken,
            RefreshToken = result.RefreshToken,
            UserId = result.User.Id,
            UserEmail = result.User.Email,
            UserName = result.User.FullName,
            UserRole = result.User.Role,
            OrgName = result.User.OrgName,
        };
        ConfigStore.SaveAuth(_auth);
        // Keep user_id in AppConfig so the tracker can build upload paths.
        _config.SetUserId(result.User.Id);
    }
}
