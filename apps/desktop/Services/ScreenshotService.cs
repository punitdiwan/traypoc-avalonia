using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using SkiaSharp;

namespace TrayPoc.Services;

/// <summary>
/// Port of the Rust <c>screenshot.rs</c>: capture the primary screen to a PNG
/// and write a downscaled JPEG thumbnail.
/// Windows uses GDI BitBlt; Linux falls back to whatever screenshot CLI is
/// present (grim / gnome-screenshot / spectacle / scrot / ImageMagick).
/// </summary>
public static class ScreenshotService
{
    private const int ThumbWidth = 480;

    /// <summary>Capture the screen to <paramref name="pngPath"/> and a thumbnail to <paramref name="thumbPath"/>.</summary>
    public static void Capture(string pngPath, string thumbPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(pngPath)!);
        CaptureScreen(pngPath);
        MakeThumbnail(pngPath, thumbPath);
    }

    private static void CaptureScreen(string pngPath)
    {
        if (OperatingSystem.IsWindows())
            CaptureWindows(pngPath);
        else if (OperatingSystem.IsLinux())
            CaptureLinux(pngPath);
        else
            throw new PlatformNotSupportedException("Screenshot capture not implemented for this OS.");
    }

    // ─── Windows (GDI) ────────────────────────────────────────────────────────

    [SupportedOSPlatform("windows")]
    private static void CaptureWindows(string pngPath)
    {
        int w = GetSystemMetrics(SM_CXSCREEN);
        int h = GetSystemMetrics(SM_CYSCREEN);
        if (w <= 0 || h <= 0)
            throw new InvalidOperationException("Could not determine screen size.");

        IntPtr screenDc = GetDC(IntPtr.Zero);
        IntPtr memDc = CreateCompatibleDC(screenDc);
        IntPtr bmp = CreateCompatibleBitmap(screenDc, w, h);
        IntPtr oldBmp = SelectObject(memDc, bmp);
        try
        {
            if (!BitBlt(memDc, 0, 0, w, h, screenDc, 0, 0, SRCCOPY | CAPTUREBLT))
                throw new InvalidOperationException("BitBlt failed.");

            var bmi = new BITMAPINFO
            {
                biSize = (uint)Marshal.SizeOf<BITMAPINFO>(),
                biWidth = w,
                biHeight = -h, // negative => top-down rows
                biPlanes = 1,
                biBitCount = 32,
                biCompression = 0, // BI_RGB
            };

            var buffer = new byte[w * h * 4];
            if (GetDIBits(memDc, bmp, 0, (uint)h, buffer, ref bmi, 0) == 0)
                throw new InvalidOperationException("GetDIBits failed.");

            // GDI yields BGRA with alpha = 0; force opaque so the PNG isn't transparent.
            for (int i = 3; i < buffer.Length; i += 4)
                buffer[i] = 255;

            // Rows are top-down (biHeight was negative), which matches Skia's layout.
            var info = new SKImageInfo(w, h, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using var image = SKImage.FromPixelCopy(info, buffer);
            using var data = image.Encode(SKEncodedImageFormat.Png, 100);
            using var fs = File.Create(pngPath);
            data.SaveTo(fs);
        }
        finally
        {
            SelectObject(memDc, oldBmp);
            DeleteObject(bmp);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    // ─── Linux (CLI fallback) ─────────────────────────────────────────────────

    private static void CaptureLinux(string pngPath)
    {
        // Try each available tool in priority order, like the Rust Wayland path.
        if (RunTool("grim", pngPath) && FileOk(pngPath)) return;
        if (RunTool("gnome-screenshot", "--file", pngPath) && FileOk(pngPath)) return;
        if (RunTool("spectacle", "-b", "-n", "-f", "-o", pngPath) && FileOk(pngPath)) return;
        if (RunTool("scrot", "-o", pngPath) && FileOk(pngPath)) return;
        if (RunTool("import", "-window", "root", pngPath) && FileOk(pngPath)) return;
        throw new InvalidOperationException(
            "No screenshot tool found. Install one of: grim, gnome-screenshot, spectacle, scrot, imagemagick.");
    }

    private static bool RunTool(string cmd, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo(cmd)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi);
            if (p is null) return false;
            p.WaitForExit(10_000);
            return p.HasExited && p.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private static bool FileOk(string path) =>
        File.Exists(path) && new FileInfo(path).Length > 0;

    // ─── thumbnail ────────────────────────────────────────────────────────────

    private static void MakeThumbnail(string pngPath, string thumbPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(thumbPath)!);
        using var original = SKBitmap.Decode(pngPath)
            ?? throw new InvalidOperationException($"Could not decode screenshot: {pngPath}");

        int height = Math.Max(1, (int)Math.Round(original.Height * (ThumbWidth / (double)original.Width)));
        var info = new SKImageInfo(ThumbWidth, height);
        using var resized = original.Resize(info, new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear))
            ?? throw new InvalidOperationException("Thumbnail resize failed.");

        using var image = SKImage.FromBitmap(resized);
        using var data = image.Encode(SKEncodedImageFormat.Jpeg, 80);
        using var fs = File.Create(thumbPath);
        data.SaveTo(fs);
    }

    // ─── Win32 interop ────────────────────────────────────────────────────────

    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const int SRCCOPY = 0x00CC0020;
    private const int CAPTUREBLT = 0x40000000;

    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr h);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(IntPtr hdcDest, int x, int y, int w, int h,
        IntPtr hdcSrc, int x1, int y1, int rop);

    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(IntPtr hdc, IntPtr hbmp, uint start, uint lines,
        byte[] bits, ref BITMAPINFO bmi, uint usage);

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
        // Color table (unused for 32bpp BI_RGB) — one entry keeps the struct valid for GetDIBits.
        public uint biColors;
    }
}
