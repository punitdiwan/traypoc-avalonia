using System;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
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
            _mainWindow.Show();

            // A second launch signals this instance to surface the window.
            Program.StartActivationListener(ShowWindow);
        }

        base.OnFrameworkInitializationCompleted();
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
        if (_mainWindow?.DataContext is MainWindowViewModel vm)
            vm.ShowAbout();
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
