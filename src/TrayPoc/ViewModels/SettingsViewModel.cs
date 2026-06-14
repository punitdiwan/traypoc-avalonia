using System;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using TrayPoc.Models;
using TrayPoc.Services;

namespace TrayPoc.ViewModels;

/// <summary>Port of the React <c>Settings</c> page (Spaces creds, tracker tuning, account, danger zone).</summary>
public partial class SettingsViewModel : ViewModelBase
{
    private readonly AppServices _services;

    [ObservableProperty] private string _spacesBucket = "";
    [ObservableProperty] private string _spacesRegion = "";
    [ObservableProperty] private string _spacesKey = "";
    [ObservableProperty] private string _spacesSecret = "";
    [ObservableProperty] private long _captureIntervalSecs = 600;
    [ObservableProperty] private long _idleThresholdSecs = 300;

    [ObservableProperty] private bool _autostartEnabled;
    [ObservableProperty] private string _saveStatus = "Save Settings";
    private bool _applyingAutostart;

    [ObservableProperty] private string _userEmail = "";
    [ObservableProperty] private string _userRole = "";

    [ObservableProperty] private string _deleteButtonText = "Delete";
    [ObservableProperty] private string? _deleteResult;
    private bool _deleteConfirming;

    public SettingsViewModel(AppServices services)
    {
        _services = services;
        Load();
    }

    public void Load()
    {
        var c = _services.Config.Current;
        SpacesBucket = c.SpacesBucket;
        SpacesRegion = string.IsNullOrEmpty(c.SpacesRegion) ? "nyc3" : c.SpacesRegion;
        SpacesKey = c.SpacesKey;
        SpacesSecret = c.SpacesSecret;
        CaptureIntervalSecs = c.CaptureIntervalSecs;
        IdleThresholdSecs = c.IdleThresholdSecs;
        UserEmail = _services.Auth.UserEmail;
        UserRole = _services.Auth.UserRole;

        _applyingAutostart = true;
        AutostartEnabled = AutostartService.IsEnabled();
        _applyingAutostart = false;
    }

    // Applies the launch-at-login change when the user flips the toggle (but not
    // while Load() is syncing the toggle from the current OS state).
    partial void OnAutostartEnabledChanged(bool value)
    {
        if (_applyingAutostart)
            return;
        AutostartService.SetEnabled(value);
    }

    [RelayCommand]
    private async Task SaveAsync()
    {
        var c = _services.Config.Current.Clone();
        c.SpacesBucket = SpacesBucket.Trim();
        c.SpacesRegion = SpacesRegion.Trim();
        c.SpacesKey = SpacesKey.Trim();
        c.SpacesSecret = SpacesSecret.Trim();
        c.CaptureIntervalSecs = Math.Clamp(CaptureIntervalSecs, 10, 3600);
        c.IdleThresholdSecs = Math.Clamp(IdleThresholdSecs, 30, 1800);
        _services.Config.Update(c);

        SaveStatus = "Saved!";
        await Task.Delay(2000);
        SaveStatus = "Save Settings";
    }

    [RelayCommand]
    private void Logout()
    {
        _services.Tracker.Stop();
        _services.Auth.Logout();
    }

    [RelayCommand]
    private async Task DeleteAllAsync()
    {
        if (!_deleteConfirming)
        {
            _deleteConfirming = true;
            DeleteButtonText = "Confirm delete";
            await Task.Delay(3000);
            if (_deleteConfirming)
            {
                _deleteConfirming = false;
                DeleteButtonText = "Delete";
            }
            return;
        }

        _deleteConfirming = false;
        DeleteButtonText = "Deleting…";
        try
        {
            long count = await _services.ClearCapturesAsync();
            DeleteResult = $"Deleted {count} interval{(count != 1 ? "s" : "")} and their screenshots.";
        }
        catch (Exception e)
        {
            DeleteResult = $"Error: {e.Message}";
        }
        finally
        {
            DeleteButtonText = "Delete";
        }
    }
}
