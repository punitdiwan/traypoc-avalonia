using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;
using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>
/// Uploads screenshots to DigitalOcean Spaces using short-lived presigned PUT
/// URLs minted by the API (<c>POST /uploads/presign</c>), so the desktop never
/// holds the Spaces credentials. Drains the local pending-upload queue.
/// Deletion of objects is handled server-side when time logs are removed.
/// </summary>
public sealed class SpacesUploader
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(120) };

    private readonly Database _db;
    private readonly ApiClient _api;
    private readonly AuthService _auth;

    public SpacesUploader(Database db, ApiClient api, AuthService auth)
    {
        _db = db;
        _api = api;
        _auth = auth;
    }

    /// <summary>Uploads need a valid session to mint presigned URLs.</summary>
    public bool CanUpload => _auth.IsAuthenticated;

    /// <summary>
    /// Upload one local file to <paramref name="relKey"/> — a path under the
    /// user's own prefix, e.g. "2026-06-15/20260615_120105.png". Returns the
    /// public URL the object is reachable at.
    /// </summary>
    public async Task<string> UploadFileAsync(string localPath, string relKey, CancellationToken ct = default)
    {
        var slot = await PresignWithRetryAsync(relKey, ContentTypeFor(relKey), ct);
        await PutAsync(slot, localPath, ct);
        return slot.PublicUrl;
    }

    /// <summary>Drain the pending_uploads queue. DB skips entries that failed 5+ times.</summary>
    public async Task DrainQueueAsync(CancellationToken ct = default)
    {
        if (!CanUpload)
            return;

        foreach (var (uploadId, intervalId, localPath, spacesKey) in _db.GetPendingUploads())
        {
            _db.MarkUploadAttempt(uploadId);
            try
            {
                string url = await UploadFileAsync(localPath, spacesKey, ct);
                _db.MarkUploaded(intervalId, url);
            }
            catch (Exception e)
            {
                Log.Warn($"upload failed (id={uploadId}): {e.Message}");
            }
        }
    }

    private async Task<PresignedUpload> PresignWithRetryAsync(string relKey, string contentType, CancellationToken ct)
    {
        var files = new[] { (relKey, contentType) };
        try
        {
            return Single(await _api.PresignUploadsAsync(files, _auth.AccessToken, ct));
        }
        catch (ApiException ex) when (ex.StatusCode == 401)
        {
            // Access token expired — refresh once, then retry.
            if (!await _auth.RefreshAsync())
                throw;
            return Single(await _api.PresignUploadsAsync(files, _auth.AccessToken, ct));
        }
    }

    private static PresignedUpload Single(System.Collections.Generic.List<PresignedUpload> list)
        => list.Count > 0 ? list[0] : throw new InvalidOperationException("presign returned no slots");

    private static async Task PutAsync(PresignedUpload slot, string localPath, CancellationToken ct)
    {
        // The file is re-opened per attempt — a consumed request/stream can't be
        // resent — so transient PUT failures are retried with backoff.
        using var resp = await HttpResilience.SendAsync(async c =>
        {
            var stream = File.OpenRead(localPath);
            var content = new StreamContent(stream);
            var req = new HttpRequestMessage(HttpMethod.Put, slot.PutUrl) { Content = content };

            // The presigned URL signs x-amz-acl and Content-Type, so they must be sent verbatim.
            foreach (var (k, v) in slot.Headers)
            {
                if (string.Equals(k, "Content-Type", StringComparison.OrdinalIgnoreCase))
                    content.Headers.ContentType = new MediaTypeHeaderValue(v);
                else
                    req.Headers.TryAddWithoutValidation(k, v);
            }

            // HttpClient disposes the request content (and so the file stream) once sent.
            return await Http.SendAsync(req, c);
        }, ct);

        if (!resp.IsSuccessStatusCode)
        {
            string text = (await resp.Content.ReadAsStringAsync(ct)).Trim();
            throw new InvalidOperationException($"PUT {(int)resp.StatusCode}: {text}");
        }
    }

    private static string ContentTypeFor(string key) =>
        key.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ? "image/png" : "image/jpeg";
}
