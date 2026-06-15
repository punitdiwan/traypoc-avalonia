using System;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using TrayPoc.Services;
using TrayPoc.ViewModels;
using TrayPoc.Views;

namespace TrayPoc;

public partial class App : Application
{
    private MainWindow? _mainWindow;
    private AppServices? _services;
    private TrayIcon? _trayIcon;
    private DispatcherTimer? _refreshTimer;
    private bool _isExiting;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            // Keep running in the tray after the window is closed.
            desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;

            _services = new AppServices();

            // Push tracker tooltip updates to the tray icon.
            var icons = TrayIcon.GetIcons(this);
            _trayIcon = icons is { Count: > 0 } ? icons[0] : null;
            _services.Tracker.SetTooltip = text =>
                Dispatcher.UIThread.Post(() => { if (_trayIcon is not null) _trayIcon.ToolTipText = text; });

            _mainWindow = new MainWindow
            {
                DataContext = new MainWindowViewModel(_services),
            };

            // Closing the window hides it to the tray instead of exiting.
            _mainWindow.Closing += (_, e) =>
            {
                if (!_isExiting)
                {
                    e.Cancel = true;
                    _mainWindow!.Hide();
                }
            };

            desktop.MainWindow = _mainWindow;

            _ = RunStartupAsync();
        }

        base.OnFrameworkInitializationCompleted();
    }

    /// <summary>
    /// Applies a pending update if there is one (then quits so the relaunch
    /// helper can take over), otherwise launches the current version.
    /// </summary>
    private async Task RunStartupAsync()
    {
        try
        {
            var update = await UpdateService.CheckForUpdateAsync();
            if (update is not null)
            {
                var window = new UpdateWindow();
                window.SetStatus($"Updating to version {update.Version}…");
                window.Show();

                var applied = await UpdateService.DownloadAndApplyAsync(update, window.Progress);
                if (applied)
                {
                    RequestExit();
                    return;
                }
                window.Close();
            }
        }
        catch
        {
            // Best-effort: never block startup on the updater.
        }

        StartNormally();
    }

    private void StartNormally()
    {
        _mainWindow?.Show();

        Program.StartActivationListener(ShowWindow);

        // Proactively refresh the access token every 12 min (expires at 15 min).
        _refreshTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(12) };
        _refreshTimer.Tick += async (_, _) =>
        {
            if (_services?.Auth.IsAuthenticated == true)
                await _services.Auth.RefreshAsync();
        };
        _refreshTimer.Start();
    }

    private void ShowWindow()
    {
        if (_mainWindow is null)
            return;

        _mainWindow.Show();
        _mainWindow.WindowState = WindowState.Normal;
        _mainWindow.Activate();
    }

    private void TrayIcon_OnClicked(object? sender, EventArgs e) => ShowWindow();

    private void ShowWindow_OnClick(object? sender, EventArgs e) => ShowWindow();

    private void ToggleTracking_OnClick(object? sender, EventArgs e)
    {
        if (_services is null)
            return;
        if (_services.Tracker.Running)
            _services.Tracker.Stop();
        else
            _services.Tracker.Start();
    }

    private void Quit_OnClick(object? sender, EventArgs e) => RequestExit();

    /// <summary>Fully exits the application (tray included).</summary>
    public void RequestExit()
    {
        _isExiting = true;
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
            desktop.Shutdown();
    }
}
