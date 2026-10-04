const METRICS_LOG_REQUEST_INTERVAL = 1000;
const METRICS_LOG_TIME_INTERVAL_MS = 5 * 60 * 1000;

const metrics = {
  startTime: Date.now(),
  requests: 0,
  htmlRequests: 0,
  markdownRequests: 0,
  errors: 0,
  retrySuccesses: 0,
  retryFailures: 0,
  rateLimited: 0,
  conversionErrors: 0,
  conversions: 0,
  totalConversionMs: 0,
  minConversionMs: Infinity,
  maxConversionMs: 0,
  lastLoggedAt: Date.now(),
  lastLoggedRequests: 0
};

export function recordRequest(type) {
  metrics.requests++;
  if (type === "html") metrics.htmlRequests++;
  if (type === "markdown") metrics.markdownRequests++;

  if (metrics.requests - metrics.lastLoggedRequests >= METRICS_LOG_REQUEST_INTERVAL ||
      Date.now() - metrics.lastLoggedAt >= METRICS_LOG_TIME_INTERVAL_MS) {
    logMetrics();
  }
}

export function recordError(errorType) {
  metrics.errors++;
  if (errorType === "retry") metrics.retryFailures++;
  if (errorType === "conversion") metrics.conversionErrors++;
  if (errorType === "rateLimit") metrics.rateLimited++;
}

export function recordRetrySuccess() {
  metrics.retrySuccesses++;
}

export function recordConversionTime(ms) {
  metrics.conversions++;
  metrics.totalConversionMs += ms;
  metrics.minConversionMs = Math.min(metrics.minConversionMs, ms);
  metrics.maxConversionMs = Math.max(metrics.maxConversionMs, ms);
}

export function getMetrics() {
  return {
    timestamp: new Date().toISOString(),
    uptime_ms: Date.now() - metrics.startTime,
    requests_total: metrics.requests,
    requests_html: metrics.htmlRequests,
    requests_markdown: metrics.markdownRequests,
    requests_rate_limited: metrics.rateLimited,
    errors_total: metrics.errors,
    errors_conversion: metrics.conversionErrors,
    errors_retry: metrics.retryFailures,
    retries_successful: metrics.retrySuccesses,
    conversions_total: metrics.conversions,
    conversion_avg_ms: metrics.conversions > 0 ? Math.round(metrics.totalConversionMs / metrics.conversions) : 0,
    conversion_min_ms: metrics.minConversionMs === Infinity ? 0 : metrics.minConversionMs,
    conversion_max_ms: metrics.maxConversionMs
  };
}

export function logMetrics() {
  const data = getMetrics();
  console.log(JSON.stringify({ type: "metrics", data }));
  metrics.lastLoggedAt = Date.now();
  metrics.lastLoggedRequests = metrics.requests;
  return data;
}
