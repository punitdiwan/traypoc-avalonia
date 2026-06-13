using System;
using System.Runtime.InteropServices;
using Avalonia.Controls;
using Avalonia.Interactivity;

namespace TrayPoc.Views;

public partial class AboutWindow : Window
{
    public AboutWindow()
    {
        InitializeComponent();

        VersionText.Text = $"Version {AppInfo.Version}";
        RuntimeText.Text =
            $"OS:    {RuntimeInformation.OSDescription}\n" +
            $"Arch:  {RuntimeInformation.OSArchitecture}\n" +
            $".NET:  {RuntimeInformation.FrameworkDescription}";

        RepoLink.NavigateUri = new Uri(AppInfo.RepoUrl);
    }

    private void Close_OnClick(object? sender, RoutedEventArgs e) => Close();
}
