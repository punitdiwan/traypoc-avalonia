using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace TrayPoc.Services;

/// <summary>
/// Keeps the machine awake (no sleep/hibernate) while time tracking is active.
///
/// • Windows: <c>SetThreadExecutionState</c> with ES_CONTINUOUS | ES_SYSTEM_REQUIRED
///   keeps the system-required flag set until it is cleared.
/// • Linux: holds a <c>systemd-inhibit … sleep infinity</c> child process whose
///   inhibitor lock blocks sleep; killing it releases the lock. Best-effort —
///   a no-op when systemd-inhibit isn't available.
///
/// Idempotent: <see cref="Inhibit"/>/<see cref="Release"/> can be called repeatedly.
/// Wire it to <see cref="TrackerService.RunningChanged"/> so it tracks capture state.
/// </summary>
public sealed class SleepInhibitor : IDisposable
{
    private readonly object _lock = new();
    private bool _active;
    private Process? _linuxInhibitor;

    [Flags]
    private enum ExecutionState : uint
    {
        Continuous = 0x80000000,
        SystemRequired = 0x00000001,
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(ExecutionState esFlags);

    public void Inhibit()
    {
        lock (_lock)
        {
            if (_active)
                return;
            try
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                {
                    SetThreadExecutionState(ExecutionState.Continuous | ExecutionState.SystemRequired);
                    _active = true;
                }
                else if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
                {
                    _active = StartLinuxInhibitor();
                }
            }
            catch (Exception e)
            {
                Log.Warn($"sleep inhibit failed: {e.Message}");
            }
        }
    }

    public void Release()
    {
        lock (_lock)
        {
            if (!_active)
                return;
            try
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                {
                    // Drop the system-required flag; ES_CONTINUOUS alone clears prior state.
                    SetThreadExecutionState(ExecutionState.Continuous);
                }
                else
                {
                    StopLinuxInhibitor();
                }
            }
            catch (Exception e)
            {
                Log.Warn($"sleep release failed: {e.Message}");
            }
            finally
            {
                _active = false;
            }
        }
    }

    private bool StartLinuxInhibitor()
    {
        var psi = new ProcessStartInfo
        {
            FileName = "systemd-inhibit",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add("--what=sleep");
        psi.ArgumentList.Add("--who=TimeTracker");
        psi.ArgumentList.Add("--why=Time tracking active");
        psi.ArgumentList.Add("--mode=block");
        psi.ArgumentList.Add("sleep");
        psi.ArgumentList.Add("infinity");
        try
        {
            _linuxInhibitor = Process.Start(psi);
            return _linuxInhibitor is { HasExited: false };
        }
        catch (Exception e)
        {
            // systemd-inhibit not present (non-systemd distro) — best-effort no-op.
            Log.Warn($"systemd-inhibit unavailable: {e.Message}");
            return false;
        }
    }

    private void StopLinuxInhibitor()
    {
        var p = _linuxInhibitor;
        _linuxInhibitor = null;
        if (p is null)
            return;
        try
        {
            if (!p.HasExited)
                p.Kill(entireProcessTree: true);
        }
        catch (Exception e)
        {
            Log.Warn($"stop inhibitor: {e.Message}");
        }
        finally
        {
            p.Dispose();
        }
    }

    public void Dispose() => Release();
}
