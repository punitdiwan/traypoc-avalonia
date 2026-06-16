using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Threading;

namespace TrayPoc.Services;

/// <summary>
/// Port of the Rust <c>activity.rs</c>. The Rust version hooked global key/mouse
/// events (evdev/rdev); .NET has no portable equivalent, so we sample OS idle
/// time instead — Windows <c>GetLastInputInfo</c>, Linux <c>xprintidle</c> — and
/// derive the same outputs: an activity percentage for an elapsed interval, plus
/// idle detection. A background thread samples every <see cref="SampleIntervalSecs"/>
/// seconds; a sample counts as "active" if input occurred during it.
/// </summary>
public sealed class ActivityMonitor
{
    private const int SampleIntervalSecs = 5;

    private readonly object _lock = new();
    private long _activeSamples;
    private long _totalSamples;
    private long _lastIdleMs; // last sampled idle time (used on Linux for live reads)
    private DateTime? _lastActiveAt;

    public void Start()
    {
        var thread = new Thread(SampleLoop)
        {
            IsBackground = true,
            Name = "activity-sampler",
        };
        thread.Start();
    }

    private void SampleLoop()
    {
        while (true)
        {
            Thread.Sleep(SampleIntervalSecs * 1000);
            long idleMs = ReadIdleMs();
            bool active = idleMs < SampleIntervalSecs * 1000;
            lock (_lock)
            {
                _lastIdleMs = idleMs;
                _totalSamples++;
                if (active)
                {
                    _activeSamples++;
                    _lastActiveAt = DateTime.UtcNow;
                }
            }
        }
    }

    /// <summary>Activity % for the elapsed interval, then resets counters (mirrors take_percent).</summary>
    public double TakePercent(long intervalSecs)
    {
        lock (_lock)
        {
            if (_totalSamples == 0)
                return 0.0;
            double pct = (double)_activeSamples / _totalSamples * 100.0;
            _activeSamples = 0;
            _totalSamples = 0;
            return pct;
        }
    }

    public bool IsIdle(long thresholdSecs) => CurrentIdleMs() >= thresholdSecs * 1000;

    public long IdleSecs() => CurrentIdleMs() / 1000;

    private long CurrentIdleMs()
    {
        if (OperatingSystem.IsWindows())
            return WindowsIdleMs();
        lock (_lock)
            return _lastIdleMs;
    }

    private long ReadIdleMs()
    {
        if (OperatingSystem.IsWindows())
            return WindowsIdleMs();
        if (OperatingSystem.IsLinux())
            return LinuxIdleMs();
        return 0;
    }

    // ─── Windows ──────────────────────────────────────────────────────────────

    [SupportedOSPlatform("windows")]
    private static long WindowsIdleMs()
    {
        var lii = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref lii))
            return 0;
        // Both values come from GetTickCount; unchecked subtraction handles wraparound.
        uint idle = unchecked((uint)Environment.TickCount - lii.dwTime);
        return idle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    // ─── Linux ────────────────────────────────────────────────────────────────

    private static long LinuxIdleMs()
    {
        // xprintidle prints idle time in ms (X11/XWayland). If absent, assume active.
        try
        {
            var psi = new ProcessStartInfo("xprintidle")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var p = Process.Start(psi);
            if (p is null) return 0;
            string outText = p.StandardOutput.ReadToEnd();
            p.WaitForExit(2000);
            return long.TryParse(outText.Trim(), out var ms) ? ms : 0;
        }
        catch
        {
            return 0; // xprintidle not installed — treat as never idle
        }
    }
}
