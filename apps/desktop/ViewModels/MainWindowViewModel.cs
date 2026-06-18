using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using TrayPoc.Services;

namespace TrayPoc.ViewModels;

/// <summary>
/// Shell view model — port of the React <c>App</c> component: hosts the Login
/// screen when signed out, and the tab bar + active page when signed in.
/// </summary>
public partial class MainWindowViewModel : ViewModelBase
{
    private readonly AppServices _services;

    public LoginViewModel LoginVm { get; }
    public DashboardViewModel DashboardVm { get; }
    public WorkDiaryViewModel DiaryVm { get; }
    public SettingsViewModel SettingsVm { get; }

    [ObservableProperty] private bool _isAuthenticated;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TrackingButtonText))]
    private bool _isTracking;

    /// <summary>Whether the Start/Stop button is enabled — Stop is always allowed
    /// while running; Start needs a project selected first.</summary>
    [ObservableProperty] private bool _canToggleTracking;

    [ObservableProperty] private string _activeTab = "dashboard";
    [ObservableProperty] private object? _currentPage;

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

        UpdateCurrentPage();
        if (IsAuthenticated)
            StartSession();
    }

    private void UpdateCanToggleTracking() =>
        CanToggleTracking = _services.Tracker.Running || _services.Tracker.CanStart;

    private void SyncAuth()
    {
        IsAuthenticated = _services.Auth.IsAuthenticated;
        if (IsAuthenticated)
            StartSession();
        else
            ActiveTab = "dashboard";
        SettingsVm.Load();
        UpdateCurrentPage();
    }

    /// <summary>Start API sync + UI refresh. Tracking itself starts only once the
    /// employee has picked a project and pressed Start (see <see cref="ToggleTracking"/>).</summary>
    private void StartSession()
    {
        _services.Sync.Start();
        DashboardVm.Activate();
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
}
