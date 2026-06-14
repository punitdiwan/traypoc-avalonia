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
    public SettingsViewModel SettingsVm { get; }

    [ObservableProperty] private bool _isAuthenticated;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TrackingButtonText))]
    private bool _isTracking;

    [ObservableProperty] private string _activeTab = "dashboard";
    [ObservableProperty] private object? _currentPage;

    public string TrackingButtonText => IsTracking ? "Stop" : "Start";

    public MainWindowViewModel(AppServices services)
    {
        _services = services;
        LoginVm = new LoginViewModel(services);
        DashboardVm = new DashboardViewModel(services);
        SettingsVm = new SettingsViewModel(services);

        IsAuthenticated = services.Auth.IsAuthenticated;
        IsTracking = services.Tracker.Running;

        services.Auth.AuthChanged += () => Dispatcher.UIThread.Post(SyncAuth);
        services.Tracker.RunningChanged += () =>
            Dispatcher.UIThread.Post(() => IsTracking = services.Tracker.Running);

        UpdateCurrentPage();
        if (IsAuthenticated)
            StartSession();
    }

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

    /// <summary>Kick off the background tracker + API sync and start UI refresh.</summary>
    private void StartSession()
    {
        _services.Tracker.Start();
        _services.Sync.Start();
        DashboardVm.Activate();
    }

    partial void OnActiveTabChanged(string value) => UpdateCurrentPage();

    private void UpdateCurrentPage() =>
        CurrentPage = ActiveTab == "settings" ? SettingsVm : (object)DashboardVm;

    [RelayCommand]
    private void SelectTab(string? tab) => ActiveTab = tab ?? "dashboard";

    [RelayCommand]
    private void ToggleTracking()
    {
        if (_services.Tracker.Running)
            _services.Tracker.Stop();
        else
            _services.Tracker.Start();
    }
}
