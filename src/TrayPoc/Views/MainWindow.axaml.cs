using Avalonia.Controls;
using Avalonia.Interactivity;
using TrayPoc.ViewModels;

namespace TrayPoc.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
    }

    private void About_OnClick(object? sender, RoutedEventArgs e)
    {
        if (DataContext is MainWindowViewModel vm)
            vm.ShowAbout();
    }

    private void Hide_OnClick(object? sender, RoutedEventArgs e) => Hide();

    private void Quit_OnClick(object? sender, RoutedEventArgs e)
    {
        if (Avalonia.Application.Current is App app)
            app.RequestExit();
    }
}
