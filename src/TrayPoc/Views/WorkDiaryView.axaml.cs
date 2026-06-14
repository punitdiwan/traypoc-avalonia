using Avalonia.Controls;
using Avalonia.Input;
using TrayPoc.ViewModels;

namespace TrayPoc.Views;

public partial class WorkDiaryView : UserControl
{
    public WorkDiaryView()
    {
        InitializeComponent();
    }

    // Click on the dimmed backdrop closes the modal.
    private void Backdrop_PointerPressed(object? sender, PointerPressedEventArgs e)
        => (DataContext as WorkDiaryViewModel)?.CloseModalCommand.Execute(null);

    // Click on the card itself should not close it.
    private void Card_PointerPressed(object? sender, PointerPressedEventArgs e)
        => e.Handled = true;
}
