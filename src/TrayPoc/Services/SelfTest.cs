using System;
using System.IO;

namespace TrayPoc.Services;

/// <summary>
/// Dev smoke test (run with <c>--selftest</c>): exercises the native-heavy paths
/// — screen capture + ImageSharp thumbnail + SQLite — without needing the API or
/// a logged-in session. Prints results and exits.
/// </summary>
public static class SelfTest
{
    public static int Run()
    {
        int failures = 0;
        string tmp = Path.Combine(Path.GetTempPath(), "tt-selftest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tmp);

        // 1. Screenshot + thumbnail
        try
        {
            string png = Path.Combine(tmp, "shot.png");
            string thumb = Path.Combine(tmp, "shot_thumb.jpg");
            ScreenshotService.Capture(png, thumb);
            var pngLen = new FileInfo(png).Length;
            var thumbLen = new FileInfo(thumb).Length;
            Console.WriteLine($"[ok] screenshot: png={pngLen} bytes, thumb={thumbLen} bytes");
            if (pngLen == 0 || thumbLen == 0) { failures++; Console.WriteLine("[FAIL] empty image"); }
        }
        catch (Exception e) { failures++; Console.WriteLine($"[FAIL] screenshot: {e.Message}"); }

        // 2. SQLite round-trip
        try
        {
            string dbPath = Path.Combine(tmp, "test.db");
            using var db = new Database(dbPath);
            long id = db.InsertInterval(DateTimeOffset.UtcNow.ToString(Database.TimeFormat),
                "/tmp/a.png", "/tmp/a_thumb.jpg", 73.5, "Self Test Window");
            db.EnqueueUpload(id, "/tmp/a.png", "user/2026-06-14/x.png");
            var recent = db.RecentIntervals(10);
            long today = db.IntervalsTodayCount();
            long pending = db.PendingUploadCount();
            Console.WriteLine($"[ok] sqlite: inserted id={id}, recent={recent.Count}, today={today}, pending={pending}");
            if (recent.Count != 1 || today != 1 || pending != 1) { failures++; Console.WriteLine("[FAIL] sqlite counts"); }
        }
        catch (Exception e) { failures++; Console.WriteLine($"[FAIL] sqlite: {e.Message}"); }

        // 3. Activity / idle read
        try
        {
            var act = new ActivityMonitor();
            long idle = act.IdleSecs();
            Console.WriteLine($"[ok] activity: idle={idle}s, isIdle(300)={act.IsIdle(300)}");
        }
        catch (Exception e) { failures++; Console.WriteLine($"[FAIL] activity: {e.Message}"); }

        // 4. Window title
        try
        {
            Console.WriteLine($"[ok] window title: {WindowTitle.GetActiveWindowTitle() ?? "(none)"}");
        }
        catch (Exception e) { failures++; Console.WriteLine($"[FAIL] window title: {e.Message}"); }

        try { Directory.Delete(tmp, recursive: true); } catch { }

        Console.WriteLine(failures == 0 ? "SELFTEST PASSED" : $"SELFTEST FAILED ({failures})");
        return failures == 0 ? 0 : 1;
    }
}
