using System;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using TrayPoc.Services;

namespace TrayPoc.ViewModels;

/// <summary>Port of the React <c>Login</c> page.</summary>
public partial class LoginViewModel : ViewModelBase
{
    private readonly AppServices _services;

    [ObservableProperty] private string _email = "";
    [ObservableProperty] private string _password = "";
    [ObservableProperty] private string _apiUrl = "";
    [ObservableProperty] private string? _error;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SignInCommand))]
    private bool _loading;

    public LoginViewModel(AppServices services)
    {
        _services = services;
        var url = services.Config.Current.ApiUrl;
        ApiUrl = string.IsNullOrWhiteSpace(url) ? "http://localhost:8080" : url;
    }

    private bool CanSignIn => !Loading;

    [RelayCommand(CanExecute = nameof(CanSignIn))]
    private async Task SignInAsync()
    {
        Error = null;
        Loading = true;
        try
        {
            // Persist the API URL first so the auth/sync clients target it.
            _services.Config.SetApiUrl(ApiUrl.Trim());
            await _services.Auth.LoginAsync(Email.Trim(), Password);
            // AuthChanged drives the shell to swap in the main UI.
            Password = "";
        }
        catch (Exception e)
        {
            Error = string.IsNullOrWhiteSpace(e.Message) ? "Login failed" : e.Message;
        }
        finally
        {
            Loading = false;
        }
    }
}
