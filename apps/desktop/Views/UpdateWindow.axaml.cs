using System;
using Avalonia.Controls;

namespace TrayPoc.Views;

public partial class UpdateWindow : Window
{
    /// <summary>
    /// Download progress sink (0..1). Constructed on the UI thread, so its
    /// callbacks are marshalled back to the UI thread automatically.
    /// </summary>
    public IProgress<double> Progress { get; }

    public UpdateWindow()
    {
        InitializeComponent();

        Progress = new Progress<double>(value =>
        {
            Bar.Value = value;
            DetailText.Text = $"Downloading… {value:P0}";
        });
    }

    /// <summary>Updates the headline status (e.g. "Updating to version 1.2.0…").</summary>
    public void SetStatus(string text) => StatusText.Text = text;
}
