using System;
using System.IO;
using System.Text.Json;
using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>
/// Loads/saves <see cref="AppConfig"/> and <see cref="AuthConfig"/> as JSON.
/// Mirrors the Rust <c>config.rs</c> / <c>auth_config.rs</c> behavior: missing
/// or malformed files fall back to defaults rather than throwing.
/// </summary>
public static class ConfigStore
{
    public static AppConfig LoadConfig()
    {
        try
        {
            if (!File.Exists(AppPaths.ConfigFile))
                return new AppConfig();
            var json = File.ReadAllText(AppPaths.ConfigFile);
            return JsonSerializer.Deserialize<AppConfig>(json, AppJson.Options) ?? new AppConfig();
        }
        catch
        {
            return new AppConfig();
        }
    }

    public static void SaveConfig(AppConfig config)
    {
        AppPaths.EnsureBaseDir();
        File.WriteAllText(AppPaths.ConfigFile, JsonSerializer.Serialize(config, AppJson.Options));
        AppPaths.RestrictToOwner(AppPaths.ConfigFile);   // holds Spaces creds
    }

    public static AuthConfig LoadAuth()
    {
        try
        {
            if (!File.Exists(AppPaths.AuthFile))
                return new AuthConfig();
            var json = File.ReadAllText(AppPaths.AuthFile);
            return JsonSerializer.Deserialize<AuthConfig>(json, AppJson.Options) ?? new AuthConfig();
        }
        catch
        {
            return new AuthConfig();
        }
    }

    public static void SaveAuth(AuthConfig auth)
    {
        AppPaths.EnsureBaseDir();
        File.WriteAllText(AppPaths.AuthFile, JsonSerializer.Serialize(auth, AppJson.Options));
        AppPaths.RestrictToOwner(AppPaths.AuthFile);     // holds access/refresh tokens
    }

    public static void ClearAuth()
    {
        try
        {
            if (File.Exists(AppPaths.AuthFile))
                File.Delete(AppPaths.AuthFile);
        }
        catch
        {
            // best-effort
        }
    }
}
