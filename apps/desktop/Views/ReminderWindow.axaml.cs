using System;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Threading;
using TrayPoc.Services;

namespace TrayPoc.Views;

public partial class ReminderWindow : Window
{
    private readonly AppServices _services;
    private DispatcherTimer? _restoreTimer;

    public ReminderWindow()
    {
        InitializeComponent();
        _services = new AppServices();
        StartRestoreTimer();
    }

    public ReminderWindow(AppServices services)
    {
        InitializeComponent();
        _services = services;
        StartRestoreTimer();
    }

    /// <summary>
    /// Every 10 seconds, bring the window back to the foreground and restore it
    /// if the user minimised or moved it to the background. This prevents the user
    /// from hiding the popup by minimising or moving the window away.
    /// </summary>
    private void StartRestoreTimer()
    {
        _restoreTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(10) };
        _restoreTimer.Tick += (_, _) =>
        {
            if (!_services.Tracker.Running)
            {
                WindowState = WindowState.Normal;
                Activate();
            }
            else
            {
                _restoreTimer?.Stop();
            }
        };
        _restoreTimer.Start();
    }

    // Prevent the user from closing the popup via the title-bar X button
    // as long as the tracker is not running.
    protected override void OnClosing(WindowClosingEventArgs e)
    {
        if (!_services.Tracker.Running)
        {
            e.Cancel = true;
            // Restore window in case it was minimised before close attempt.
            WindowState = WindowState.Normal;
            Activate();
        }
        else
        {
            _restoreTimer?.Stop();
            base.OnClosing(e);
        }
    }

    private void Start_OnClick(object? sender, RoutedEventArgs e)
    {
        if (_services.Tracker.Running)
        {
            _restoreTimer?.Stop();
            Close();
            return;
        }

        if (_services.Tracker.CanStart)
        {
            _services.Tracker.Start();
            _restoreTimer?.Stop();
            Close();
        }
        else
        {
            ErrorText.Text = "⚠  No project selected. Please select a project in the main window first.";

            try
            {
                if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
                {
                    desktop.MainWindow?.Show();
                    desktop.MainWindow?.Activate();
                }
            }
            catch { }
        }
    }
}
