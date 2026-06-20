using System;

namespace TrayPoc.Services;

/// <summary>
/// Thread-safe holder for the employer-controlled policy the desktop polls from
/// the API (see <see cref="SyncService"/>), so the app reacts to changes made on
/// the web dashboard without a re-login:
///   • <see cref="CanTrack"/>      — tracking is allowed at all,
///   • <see cref="AllowManualTime"/> — manual (screenshot-less) entry is allowed.
/// <see cref="Changed"/> fires (off the UI thread) whenever any of these — or the
/// set/rates of assigned projects — change, so the tracker and view models can
/// react (stop tracking, refresh the project list, toggle the manual-entry UI).
/// The server stays authoritative; this only drives client responsiveness.
/// </summary>
public sealed class PolicyState
{
    private readonly object _lock = new();
    // Optimistic defaults: login already required can_track=true, so we assume
    // tracking is allowed until the first poll says otherwise (avoids a spurious
    // "tracking disabled" flash on startup).
    private bool _canTrack = true;
    private bool _allowManualTime;
    private bool _requireNotes;
    private string _projectsSig = "";

    public bool CanTrack { get { lock (_lock) return _canTrack; } }
    public bool AllowManualTime { get { lock (_lock) return _allowManualTime; } }
    public bool RequireNotes { get { lock (_lock) return _requireNotes; } }

    /// <summary>Raised when the policy changes. Handlers run on the caller's
    /// (background) thread and must marshal any UI work themselves.</summary>
    public event Action? Changed;

    /// <summary>Apply a freshly-polled policy. Fires <see cref="Changed"/> only if
    /// something actually differs, so idle polls are cheap and event-free.</summary>
    public void Apply(bool canTrack, bool allowManual, bool requireNotes, string projectsSig)
    {
        bool changed;
        lock (_lock)
        {
            changed = _canTrack != canTrack
                   || _allowManualTime != allowManual
                   || _requireNotes != requireNotes
                   || _projectsSig != projectsSig;
            _canTrack = canTrack;
            _allowManualTime = allowManual;
            _requireNotes = requireNotes;
            _projectsSig = projectsSig;
        }
        if (changed)
            Changed?.Invoke();
    }

    /// <summary>Reset to optimistic defaults on logout so a later login starts clean.</summary>
    public void Reset()
    {
        lock (_lock)
        {
            _canTrack = true;
            _allowManualTime = false;
            _requireNotes = false;
            _projectsSig = "";
        }
    }
}
