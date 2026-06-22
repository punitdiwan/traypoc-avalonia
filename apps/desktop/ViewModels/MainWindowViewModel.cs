using System;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using TrayPoc.Services;
using TrayPoc.Views;

namespace TrayPoc.ViewModels;

/// <summary>
/// Shell view model — port of the React <c>App</c> component: hosts the Login
/// screen when signed out, and the tab bar + active page when signed in.
/// </summary>
public partial class MainWindowViewModel : ViewModelBase
{
    private readonly AppServices _services;
    private DispatcherTimer? _reminderTimer;
    private int _stoppedSeconds = 0;
    private static ReminderWindow? _activeReminder;

    public LoginViewModel LoginVm { get; }
    public DashboardViewModel DashboardVm { get; }
    public WorkDiaryViewModel DiaryVm { get; }
    public SettingsViewModel SettingsVm { get; }

    [ObservableProperty] private bool _isAuthenticated;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TrackingButtonText))]
    private bool _isTracking;

    /// <summary>Whether the Start/Stop button is enabled — Stop is always allowed
    /// while running; Start needs a project selected first. Locked while on a break
    /// (only "End break" resumes tracking).</summary>
    [ObservableProperty] private bool _canToggleTracking;

    /// <summary>True when signed in but the employer has turned tracking off — drives
    /// a banner and disables Start. Updated from the background policy poll.</summary>
    [ObservableProperty] private bool _trackingDisabledByOrg;

    [ObservableProperty] private string _activeTab = "dashboard";
    [ObservableProperty] private object? _currentPage;

    /// <summary>The signed-in user's display name (email as a fallback for legacy
    /// blank names) — shown in the top bar.</summary>
    [ObservableProperty] private string _signedInAs = "";

    /// <summary>The org the user belongs to, shown below the name in the top bar.
    /// Empty for god/unattached users.</summary>
    [ObservableProperty] private string _orgName = "";

    public string TrackingButtonText => IsTracking ? "Stop" : "Start";

    public MainWindowViewModel(AppServices services)
    {
        _services = services;
        LoginVm = new LoginViewModel(services);
        DashboardVm = new DashboardViewModel(services);
        DiaryVm = new WorkDiaryViewModel(services);
        SettingsVm = new SettingsViewModel(services);

        // Restore the previously-selected project so tracking can resume.
        var savedProject = services.Config.Current.SelectedProjectId;
        if (!string.IsNullOrEmpty(savedProject))
            services.Tracker.SelectedProjectId = savedProject;

        IsAuthenticated = services.Auth.IsAuthenticated;
        IsTracking = services.Tracker.Running;
        UpdateSignedInAs();
        UpdateCanToggleTracking();

        services.Auth.AuthChanged += () => Dispatcher.UIThread.Post(SyncAuth);
        services.Tracker.RunningChanged += () =>
            Dispatcher.UIThread.Post(() =>
            {
                IsTracking = services.Tracker.Running;
                UpdateCanToggleTracking();
            });
        services.Tracker.SelectedProjectChanged += () =>
            Dispatcher.UIThread.Post(UpdateCanToggleTracking);
        services.Tracker.NotesChanged += () =>
            Dispatcher.UIThread.Post(UpdateCanToggleTracking);
        // On break, the Start/Stop button is locked — only "End break" resumes tracking.
        services.Tracker.BreakChanged += () =>
            Dispatcher.UIThread.Post(UpdateCanToggleTracking);
        // Background policy poll → react on the UI thread (gate Start, show banner).
        services.Policy.Changed += () => Dispatcher.UIThread.Post(SyncPolicy);

        UpdateCurrentPage();
        if (IsAuthenticated)
            StartSession();

        _reminderTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _reminderTimer.Tick += (s, e) => CheckReminder();
        _reminderTimer.Start();
    }

    private void UpdateCanToggleTracking() =>
        CanToggleTracking = !_services.Tracker.OnBreak
            && (_services.Tracker.Running || _services.Tracker.CanStart);

    /// <summary>Reflect the latest polled policy: refresh the Start gate and surface
    /// the "tracking turned off by your organization" banner.</summary>
    private void SyncPolicy()
    {
        TrackingDisabledByOrg = IsAuthenticated && !_services.Policy.CanTrack;
        IsTracking = _services.Tracker.Running;
        UpdateCanToggleTracking();
    }

    /// <summary>Set the top-bar identity label and org name from the current auth state.</summary>
    private void UpdateSignedInAs()
    {
        SignedInAs = string.IsNullOrWhiteSpace(_services.Auth.UserName)
            ? _services.Auth.UserEmail
            : _services.Auth.UserName;
        OrgName = _services.Auth.OrgName;
    }

    private void SyncAuth()
    {
        IsAuthenticated = _services.Auth.IsAuthenticated;
        UpdateSignedInAs();
        if (IsAuthenticated)
        {
            StartSession();
        }
        else
        {
            // Session ended (logout, or a refresh the server refused because tracking
            // was disabled / the member was released): make sure capture halts and the
            // policy resets so the next login starts clean.
            _services.Tracker.Stop();
            _services.Policy.Reset();
            TrackingDisabledByOrg = false;
            ActiveTab = "dashboard";
        }
        SettingsVm.Load();
        UpdateCurrentPage();
    }

    /// <summary>Start API sync + UI refresh. Tracking itself starts only once the
    /// employee has picked a project and pressed Start (see <see cref="ToggleTracking"/>).</summary>
    private void StartSession()
    {
        _services.Sync.Start();
        DashboardVm.Activate();

        if (_services.Config.Current.AutoStartTracking && _services.Tracker.CanStart && !_services.Tracker.Running)
        {
            _services.Tracker.Start();
        }
    }

    partial void OnActiveTabChanged(string value) => UpdateCurrentPage();

    private void UpdateCurrentPage()
    {
        CurrentPage = ActiveTab switch
        {
            "diary" => DiaryVm,
            "settings" => SettingsVm,
            _ => DashboardVm,
        };
        if (ActiveTab == "diary")
            DiaryVm.Activate();
    }

    [RelayCommand]
    private void SelectTab(string? tab) => ActiveTab = tab ?? "dashboard";

    [RelayCommand]
    private void ToggleTracking()
    {
        if (_services.Tracker.Running)
            _services.Tracker.Stop();
        else if (_services.Tracker.CanStart) // refuses to start without a project
            _services.Tracker.Start();
    }

    private void CheckReminder()
    {
        if (IsAuthenticated && !_services.Tracker.Running)
        {
            _stoppedSeconds += 5;
            if (_stoppedSeconds >= 120)
            {
                _stoppedSeconds = 0;
                ShowReminderPopup();
            }
        }
        else
        {
            _stoppedSeconds = 0;
        }
    }

    private void ShowReminderPopup()
    {
        if (_activeReminder is not null)
            return;

        _activeReminder = new ReminderWindow(_services);
        _activeReminder.Closed += (s, e) => _activeReminder = null;
        _activeReminder.Show();
    }
}
