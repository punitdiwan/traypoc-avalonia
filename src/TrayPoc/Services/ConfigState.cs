using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>
/// Thread-safe holder for the live <see cref="AppConfig"/> (the Rust app used an
/// <c>RwLock&lt;AppConfig&gt;</c>). All readers call <see cref="Current"/>; writers
/// go through <see cref="Update"/> / <see cref="SetUserId"/>, which also persist.
/// </summary>
public sealed class ConfigState
{
    private readonly object _lock = new();
    private AppConfig _current;

    public ConfigState() => _current = ConfigStore.LoadConfig();

    public AppConfig Current
    {
        get { lock (_lock) return _current; }
    }

    public void Update(AppConfig config)
    {
        lock (_lock)
        {
            _current = config;
            ConfigStore.SaveConfig(config);
        }
    }

    public void SetUserId(string userId)
    {
        lock (_lock)
        {
            _current.UserId = userId;
            ConfigStore.SaveConfig(_current);
        }
    }

    public void SetApiUrl(string apiUrl)
    {
        lock (_lock)
        {
            _current.ApiUrl = apiUrl;
            ConfigStore.SaveConfig(_current);
        }
    }
}
