using System;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using TrayPoc.Services;
using TrayPoc.ViewModels;
using TrayPoc.Views;

namespace TrayPoc;

public partial class App : Application
{
    private MainWindow? _mainWindow;
    private bool _isExiting;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            // Keep the process alive when the window is closed so the app keeps
            // running in the system tray until the user explicitly chooses Quit.
            desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;

            _mainWindow = new MainWindow
            {
                DataContext = new MainWindowViewModel(),
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

            // Check for a newer release before showing the UI. If one is found
            // it is installed and the app relaunches; otherwise we just start
            // normally on the current version.
            _ = RunStartupAsync();
        }

        base.OnFrameworkInitializationCompleted();
    }

    /// <summary>
    /// Startup gate: applies a pending update if there is one (then quits so the
    /// relaunch helper can take over), otherwise launches the current version.
    /// Best-effort — any failure falls through to a normal launch.
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
                    // The helper will install the update and relaunch the app
                    // once this process exits, so quit now.
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

    /// <summary>Shows the main window and begins listening for second-launch activations.</summary>
    private void StartNormally()
    {
        _mainWindow?.Show();

        // A second launch signals this instance to surface the window.
        Program.StartActivationListener(ShowWindow);
    }

    private void ShowWindow()
    {
        if (_mainWindow is null)
            return;

        _mainWindow.Show();
        _mainWindow.WindowState = WindowState.Normal;
        _mainWindow.Activate();
    }

    // Activating the tray icon (single click on Windows) shows the window.
    private void TrayIcon_OnClicked(object? sender, EventArgs e) => ShowWindow();

    private void ShowWindow_OnClick(object? sender, EventArgs e) => ShowWindow();

    private void HideWindow_OnClick(object? sender, EventArgs e) => _mainWindow?.Hide();

    private void About_OnClick(object? sender, EventArgs e)
    {
        ShowWindow();
        if (_mainWindow is not null)
            new Views.AboutWindow().ShowDialog(_mainWindow);
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
