using System;
using System.IO;
using System.Threading.Tasks;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using TrayPoc.Models;

namespace TrayPoc.Services;

/// <summary>
/// Port of the Rust <c>uploader.rs</c>: uploads screenshots to DigitalOcean
/// Spaces (S3-compatible) with a public-read ACL, deletes objects, and drains
/// the local pending-upload queue.
/// </summary>
public sealed class SpacesUploader
{
    private readonly Database _db;

    public SpacesUploader(Database db) => _db = db;

    private static AmazonS3Client BuildClient(AppConfig config)
    {
        var creds = new BasicAWSCredentials(config.SpacesKey, config.SpacesSecret);
        var s3Config = new AmazonS3Config
        {
            ServiceURL = $"https://{config.SpacesRegion}.digitaloceanspaces.com",
            ForcePathStyle = false,
            AuthenticationRegion = config.SpacesRegion,
        };
        return new AmazonS3Client(creds, s3Config);
    }

    public async Task<string> UploadFileAsync(string localPath, string spacesKey, AppConfig config)
    {
        using var client = BuildClient(config);
        string contentType = spacesKey.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
            ? "image/png"
            : "image/jpeg";

        await using var stream = File.OpenRead(localPath);
        var req = new PutObjectRequest
        {
            BucketName = config.SpacesBucket,
            Key = spacesKey,
            InputStream = stream,
            ContentType = contentType,
            CannedACL = S3CannedACL.PublicRead,
            DisablePayloadSigning = true,
        };
        await client.PutObjectAsync(req);

        return $"https://{config.SpacesBucket}.{config.SpacesRegion}.digitaloceanspaces.com/{spacesKey}";
    }

    public async Task DeleteFromSpacesAsync(string spacesUrl, AppConfig config)
    {
        string prefix = $"https://{config.SpacesBucket}.{config.SpacesRegion}.digitaloceanspaces.com/";
        string key = spacesUrl.StartsWith(prefix, StringComparison.Ordinal)
            ? spacesUrl[prefix.Length..]
            : "";
        if (string.IsNullOrEmpty(key))
            throw new InvalidOperationException($"cannot derive key from URL: {spacesUrl}");

        using var client = BuildClient(config);
        await client.DeleteObjectAsync(new DeleteObjectRequest
        {
            BucketName = config.SpacesBucket,
            Key = key,
        });
    }

    /// <summary>Drain the pending_uploads queue. Skips entries that failed 5+ times.</summary>
    public async Task DrainQueueAsync(AppConfig config)
    {
        if (!config.IsConfigured())
            return;

        var entries = _db.GetPendingUploads();
        foreach (var (uploadId, intervalId, localPath, spacesKey) in entries)
        {
            _db.MarkUploadAttempt(uploadId);
            try
            {
                string url = await UploadFileAsync(localPath, spacesKey, config);
                _db.MarkUploaded(intervalId, url);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"upload failed (id={uploadId}): {e.Message}");
            }
        }
    }
}
