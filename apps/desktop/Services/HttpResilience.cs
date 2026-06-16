using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Polly;
using Polly.Retry;

namespace TrayPoc.Services;

/// <summary>
/// Shared retry/backoff for the app's outbound HTTP (interval sync + presigned
/// uploads). Transient failures — connection errors, HttpClient timeouts, and
/// 5xx/408/429 responses — are retried with exponential backoff + jitter.
/// Everything else (including 4xx like 401) passes straight through so callers
/// can react, e.g. refresh-the-token-on-401. Genuine cancellation is never
/// retried (a user-cancelled <see cref="TaskCanceledException"/> has no
/// <see cref="TimeoutException"/> inner, and Polly honours the token).
/// </summary>
public static class HttpResilience
{
    private static readonly ResiliencePipeline<HttpResponseMessage> Pipeline =
        new ResiliencePipelineBuilder<HttpResponseMessage>()
            .AddRetry(new RetryStrategyOptions<HttpResponseMessage>
            {
                ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
                    .Handle<HttpRequestException>()
                    .Handle<TaskCanceledException>(ex => ex.InnerException is TimeoutException)
                    .HandleResult(r => IsTransientStatus(r.StatusCode)),
                MaxRetryAttempts = 4,
                BackoffType = DelayBackoffType.Exponential,
                UseJitter = true,
                Delay = TimeSpan.FromSeconds(1),
                OnRetry = args =>
                {
                    // Drop the failed response before retrying so it doesn't leak.
                    args.Outcome.Result?.Dispose();
                    string why = args.Outcome.Exception?.Message
                        ?? $"HTTP {(int?)args.Outcome.Result?.StatusCode}";
                    Log.Warn($"http retry {args.AttemptNumber + 1} in {args.RetryDelay.TotalSeconds:0.0}s ({why})");
                    return default;
                },
            })
            .Build();

    /// <summary>
    /// Execute an HTTP request with retry/backoff. The request is rebuilt on each
    /// attempt — <see cref="HttpRequestMessage"/> and its content stream can't be
    /// resent — so pass a factory rather than a prepared request.
    /// </summary>
    public static ValueTask<HttpResponseMessage> SendAsync(
        Func<CancellationToken, ValueTask<HttpResponseMessage>> send, CancellationToken ct = default)
        => Pipeline.ExecuteAsync(send, ct);

    private static bool IsTransientStatus(HttpStatusCode code) =>
        (int)code >= 500 || code == HttpStatusCode.RequestTimeout || (int)code == 429;
}
