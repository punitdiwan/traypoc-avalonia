using System;
using System.Collections.Generic;
using Microsoft.Data.Sqlite;
using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>
/// SQLite store — port of the Rust <c>db.rs</c>. The original guarded a single
/// connection behind a Mutex; we mirror that with one long-lived connection and
/// a lock, since the tracker, sync and UI threads all touch it.
/// </summary>
public sealed class Database : IDisposable
{
    private readonly SqliteConnection _conn;
    private readonly object _lock = new();

    /// <summary>UTC ISO-8601 with milliseconds + 'Z' — parseable by SQLite's DATE()/datetime().</summary>
    public const string TimeFormat = "yyyy-MM-ddTHH:mm:ss.fff'Z'";

    public Database(string path)
    {
        _conn = new SqliteConnection($"Data Source={path}");
        _conn.Open();
        Exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
        Exec("""
            CREATE TABLE IF NOT EXISTS time_intervals (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                start_time       TEXT NOT NULL,
                end_time         TEXT,
                screenshot_path  TEXT,
                thumb_path       TEXT,
                spaces_url       TEXT,
                activity_percent REAL NOT NULL DEFAULT 0.0,
                window_title     TEXT,
                synced           INTEGER NOT NULL DEFAULT 0,
                api_id           TEXT,
                created_at       TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS pending_uploads (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                interval_id  INTEGER NOT NULL,
                local_path   TEXT NOT NULL,
                spaces_key   TEXT NOT NULL,
                attempts     INTEGER NOT NULL DEFAULT 0,
                last_attempt TEXT,
                FOREIGN KEY (interval_id) REFERENCES time_intervals(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS breaks (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at    TEXT NOT NULL,
                duration_secs INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_intervals_start ON time_intervals(start_time);
            CREATE INDEX IF NOT EXISTS idx_intervals_synced ON time_intervals(synced);
            CREATE INDEX IF NOT EXISTS idx_breaks_started ON breaks(started_at);
            """);

        // The project the interval was tracked against; added after the initial
        // release, so apply it idempotently for existing databases.
        EnsureColumn("time_intervals", "project_id", "TEXT");
        // Manual-mode intervals carry no screenshot; flagged so they sync without
        // waiting on a Spaces upload. Added later, so apply idempotently too.
        EnsureColumn("time_intervals", "manual", "INTEGER NOT NULL DEFAULT 0");
        // Free-text working notes the employee attaches to each interval. Added later.
        EnsureColumn("time_intervals", "notes", "TEXT");
        // Process/app name of the active window at capture time (e.g. "chrome", "Code").
        EnsureColumn("time_intervals", "app_name", "TEXT");
    }

    /// <summary>Adds a column if it isn't already present (SQLite has no
    /// ADD COLUMN IF NOT EXISTS).</summary>
    private void EnsureColumn(string table, string column, string type)
    {
        lock (_lock)
        {
            using (var check = _conn.CreateCommand())
            {
                check.CommandText = $"SELECT 1 FROM pragma_table_info('{table}') WHERE name = $col";
                check.Parameters.AddWithValue("$col", column);
                if (check.ExecuteScalar() is not null)
                    return;
            }
            Exec($"ALTER TABLE {table} ADD COLUMN {column} {type};");
        }
    }

    private void Exec(string sql)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    public long InsertInterval(string startTime, string? screenshotPath, string? thumbPath,
        double activityPercent, string? windowTitle, string? projectId, bool manual = false,
        string? notes = null, string? appName = null)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO time_intervals
                 (start_time, end_time, screenshot_path, thumb_path, activity_percent, window_title, project_id, manual, notes, app_name)
                 VALUES ($start, $start, $shot, $thumb, $act, $title, $project, $manual, $notes, $appname);
                SELECT last_insert_rowid();
                """;
            cmd.Parameters.AddWithValue("$start", startTime);
            cmd.Parameters.AddWithValue("$shot", (object?)screenshotPath ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$thumb", (object?)thumbPath ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$act", activityPercent);
            cmd.Parameters.AddWithValue("$title", (object?)windowTitle ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$project", (object?)projectId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$manual", manual ? 1 : 0);
            var notesVal = string.IsNullOrWhiteSpace(notes) ? null : notes.Trim();
            cmd.Parameters.AddWithValue("$notes", (object?)notesVal ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$appname", (object?)appName ?? DBNull.Value);
            return (long)(cmd.ExecuteScalar() ?? 0L);
        }
    }

    public void EnqueueUpload(long intervalId, string localPath, string spacesKey)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText =
                "INSERT INTO pending_uploads (interval_id, local_path, spaces_key) VALUES ($i, $p, $k)";
            cmd.Parameters.AddWithValue("$i", intervalId);
            cmd.Parameters.AddWithValue("$p", localPath);
            cmd.Parameters.AddWithValue("$k", spacesKey);
            cmd.ExecuteNonQuery();
        }
    }

    public void MarkUploaded(long intervalId, string spacesUrl)
    {
        lock (_lock)
        {
            using var t = _conn.BeginTransaction();
            using (var c1 = _conn.CreateCommand())
            {
                c1.Transaction = t;
                c1.CommandText = "UPDATE time_intervals SET spaces_url = $u WHERE id = $id";
                c1.Parameters.AddWithValue("$u", spacesUrl);
                c1.Parameters.AddWithValue("$id", intervalId);
                c1.ExecuteNonQuery();
            }
            using (var c2 = _conn.CreateCommand())
            {
                c2.Transaction = t;
                c2.CommandText = "DELETE FROM pending_uploads WHERE interval_id = $id";
                c2.Parameters.AddWithValue("$id", intervalId);
                c2.ExecuteNonQuery();
            }
            t.Commit();
        }
    }

    public void MarkUploadAttempt(long uploadId)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText =
                "UPDATE pending_uploads SET attempts = attempts + 1, last_attempt = datetime('now') WHERE id = $id";
            cmd.Parameters.AddWithValue("$id", uploadId);
            cmd.ExecuteNonQuery();
        }
    }

    public long PendingUploadCount() => ScalarLong("SELECT COUNT(*) FROM pending_uploads");

    public long IntervalsTodayCount() =>
        ScalarLong("SELECT COUNT(*) FROM time_intervals WHERE DATE(start_time) = DATE('now')");

    /// <summary>Record a break the employee took (timestamped in local time), for
    /// per-day limit enforcement.</summary>
    public void InsertBreak(long durationSecs)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "INSERT INTO breaks (started_at, duration_secs) VALUES (datetime('now','localtime'), $d)";
            cmd.Parameters.AddWithValue("$d", durationSecs);
            cmd.ExecuteNonQuery();
        }
    }

    /// <summary>Number of breaks taken today (local date, matching DATE('now','localtime')).</summary>
    public long BreakCountToday() =>
        ScalarLong("SELECT COUNT(*) FROM breaks WHERE DATE(started_at) = DATE('now','localtime')");

    /// <summary>Total seconds of break time taken today (local date).</summary>
    public long BreakSecondsToday() =>
        ScalarLong("SELECT COALESCE(SUM(duration_secs),0) FROM breaks WHERE DATE(started_at) = DATE('now','localtime')");

    public string? LastCaptureTime()
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT start_time FROM time_intervals ORDER BY start_time DESC LIMIT 1";
            var r = cmd.ExecuteScalar();
            return r is string s ? s : null;
        }
    }

    public List<TimeInterval> RecentIntervals(long limit)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = SelectCols + " ORDER BY start_time DESC LIMIT $lim";
            cmd.Parameters.AddWithValue("$lim", limit);
            return ReadIntervals(cmd);
        }
    }

    public List<TimeInterval> PendingSyncIntervals()
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = SelectCols + " WHERE synced = 0 ORDER BY start_time ASC LIMIT 50";
            return ReadIntervals(cmd);
        }
    }

    public List<TimeInterval> GetIntervalsForDate(string date)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = SelectCols + " WHERE DATE(start_time) = $d ORDER BY start_time ASC";
            cmd.Parameters.AddWithValue("$d", date);
            return ReadIntervals(cmd);
        }
    }

    /// <summary>
    /// (id, screenshot_path) for intervals that are fully uploaded to Spaces AND
    /// synced to the API — their local full-res PNG is now redundant and safe to
    /// delete. Thumbnails are kept so the Work Diary still renders offline.
    /// </summary>
    public List<(long Id, string Path)> ScreenshotsToPrune()
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText =
                "SELECT id, screenshot_path FROM time_intervals " +
                "WHERE synced = 1 AND spaces_url IS NOT NULL AND screenshot_path IS NOT NULL";
            using var r = cmd.ExecuteReader();
            var list = new List<(long, string)>();
            while (r.Read())
                list.Add((r.GetInt64(0), r.GetString(1)));
            return list;
        }
    }

    /// <summary>Clears the local full-res path once the PNG has been pruned from disk.</summary>
    public void ClearScreenshotPath(long id)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "UPDATE time_intervals SET screenshot_path = NULL WHERE id = $id";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.ExecuteNonQuery();
        }
    }

    /// <summary>(upload_id, interval_id, local_path, spaces_key) for queued uploads under 5 attempts.</summary>
    public List<(long UploadId, long IntervalId, string LocalPath, string SpacesKey)> GetPendingUploads()
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText =
                "SELECT id, interval_id, local_path, spaces_key FROM pending_uploads WHERE attempts < 5 ORDER BY id ASC LIMIT 10";
            using var r = cmd.ExecuteReader();
            var list = new List<(long, long, string, string)>();
            while (r.Read())
                list.Add((r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3)));
            return list;
        }
    }

    /// <summary>(id, api_id, thumb_path) for synced intervals carrying a server id whose
    /// start date falls in [fromDate, toDate]. Used to reconcile server-side deletions:
    /// any of these whose api_id is no longer present on the server was deleted there.</summary>
    public List<(long Id, string ApiId, string? ThumbPath)> SyncedIntervalsInRange(string fromDate, string toDate)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText =
                "SELECT id, api_id, thumb_path FROM time_intervals " +
                "WHERE synced = 1 AND api_id IS NOT NULL AND DATE(start_time) BETWEEN $from AND $to";
            cmd.Parameters.AddWithValue("$from", fromDate);
            cmd.Parameters.AddWithValue("$to", toDate);
            using var r = cmd.ExecuteReader();
            var list = new List<(long, string, string?)>();
            while (r.Read())
                list.Add((r.GetInt64(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2)));
            return list;
        }
    }

    /// <summary>Delete a single interval (its pending_uploads cascade away via FK).
    /// Used when the corresponding server-side time log was deleted from the web.</summary>
    public void DeleteInterval(long id)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "DELETE FROM time_intervals WHERE id = $id";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.ExecuteNonQuery();
        }
    }

    public void SetSynced(long id, string apiId)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "UPDATE time_intervals SET synced = 1, api_id = $api WHERE id = $id";
            cmd.Parameters.AddWithValue("$api", apiId);
            cmd.Parameters.AddWithValue("$id", id);
            cmd.ExecuteNonQuery();
        }
    }

    /// <summary>Wipes both tables; returns number of intervals deleted.</summary>
    public long ClearAll()
    {
        lock (_lock)
        {
            Exec("DELETE FROM pending_uploads");
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "DELETE FROM time_intervals";
            return cmd.ExecuteNonQuery();
        }
    }

    private const string SelectCols =
        "SELECT id, start_time, end_time, screenshot_path, thumb_path, spaces_url, " +
        "activity_percent, window_title, synced, project_id, manual, notes, app_name FROM time_intervals";

    private static List<TimeInterval> ReadIntervals(SqliteCommand cmd)
    {
        using var r = cmd.ExecuteReader();
        var list = new List<TimeInterval>();
        while (r.Read())
        {
            list.Add(new TimeInterval
            {
                Id = r.GetInt64(0),
                StartTime = r.GetString(1),
                EndTime = r.IsDBNull(2) ? null : r.GetString(2),
                ScreenshotPath = r.IsDBNull(3) ? null : r.GetString(3),
                ThumbPath = r.IsDBNull(4) ? null : r.GetString(4),
                SpacesUrl = r.IsDBNull(5) ? null : r.GetString(5),
                ActivityPercent = r.IsDBNull(6) ? 0 : r.GetDouble(6),
                WindowTitle = r.IsDBNull(7) ? null : r.GetString(7),
                Synced = !r.IsDBNull(8) && r.GetInt32(8) != 0,
                ProjectId = r.IsDBNull(9) ? null : r.GetString(9),
                Manual = !r.IsDBNull(10) && r.GetInt32(10) != 0,
                Notes = r.IsDBNull(11) ? null : r.GetString(11),
                AppName = r.IsDBNull(12) ? null : r.GetString(12),
            });
        }
        return list;
    }

    private long ScalarLong(string sql)
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = sql;
            return Convert.ToInt64(cmd.ExecuteScalar() ?? 0L);
        }
    }

    public void Dispose() => _conn.Dispose();
}
