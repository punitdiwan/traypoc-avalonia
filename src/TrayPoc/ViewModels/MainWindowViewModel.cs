using System;
using System.Runtime.InteropServices;
using CommunityToolkit.Mvvm.ComponentModel;

namespace TrayPoc.ViewModels;

public partial class MainWindowViewModel : ViewModelBase
{
    public string Greeting { get; } = "TrayPoc — Avalonia cross-platform POC";

    public string RuntimeInfo { get; } =
        $"OS:    {RuntimeInformation.OSDescription}\n" +
        $"Arch:  {RuntimeInformation.OSArchitecture}\n" +
        $".NET:  {RuntimeInformation.FrameworkDescription}";

    [ObservableProperty]
    private string _status = "Running. Close the window to keep the app alive in the system tray.";

    public void ShowAbout()
    {
        Status = $"TrayPoc POC • Avalonia UI • {RuntimeInformation.FrameworkDescription} • " +
                 $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}";
    }
}
