using Avalonia;
using Avalonia.Threading;
using System;
using System.IO.Pipes;
using System.Threading;

namespace TrayPoc;

sealed class Program
{
    // Unique, app-specific names so the mutex/pipe don't collide with other apps.
    private const string MutexName = "TrayPoc.SingleInstance.6f3d2a4e-1b7c-4f2a-9c10";
    private const string PipeName  = "TrayPoc.Activate.6f3d2a4e-1b7c-4f2a-9c10";

    // Held for the lifetime of the first instance; releasing it lets a future
    // launch become the new owner. Kept in a field so it is not GC'd early.
    private static Mutex? _instanceMutex;

    // Initialization code. Don't use any Avalonia, third-party APIs or any
    // SynchronizationContext-reliant code before AppMain is called: things aren't initialized
    // yet and stuff might break.
    [STAThread]
    public static void Main(string[] args)
    {
        Services.Log.Init();

        // Dev smoke test for the native-heavy services (no UI / API needed).
        if (Array.IndexOf(args, "--selftest") >= 0)
        {
            Environment.Exit(Services.SelfTest.Run());
            return;
        }

        // Single instance: the first process to grab the named mutex wins.
        _instanceMutex = new Mutex(initiallyOwned: true, MutexName, out bool isFirstInstance);
        if (!isFirstInstance)
        {
            // Another instance is already running — ask it to surface, then exit.
            TrySignalExistingInstance();
            return;
        }

        try
        {
            BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
        }
        finally
        {
            _instanceMutex.ReleaseMutex();
            _instanceMutex.Dispose();
        }
    }

    /// <summary>
    /// Background listener (started by <see cref="App"/>) that lets a second
    /// launch tell the running instance to show its window.
    /// </summary>
    public static void StartActivationListener(Action onActivate)
    {
        var thread = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    using var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1);
                    server.WaitForConnection();
                    if (server.ReadByte() >= 0)
                        Dispatcher.UIThread.Post(onActivate);
                }
                catch
                {
                    // Pipe churn between connections — back off briefly and retry.
                    Thread.Sleep(200);
                }
            }
        })
        {
            IsBackground = true,
            Name = "TrayPoc-activation-listener",
        };
        thread.Start();
    }

    private static void TrySignalExistingInstance()
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(1000);
            client.WriteByte(1);
            client.Flush();
        }
        catch
        {
            // Best effort: if the running instance isn't listening (yet), just exit quietly.
        }
    }

    // Avalonia configuration, don't remove; also used by visual designer.
    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
#if DEBUG
            .WithDeveloperTools()
#endif
            .WithInterFont()
            .LogToTrace();
}
