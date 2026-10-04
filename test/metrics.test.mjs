import assert from "node:assert/strict";
import test from "node:test";
import { getMetrics, logMetrics, recordConversionTime, recordError, recordRequest, recordRetrySuccess } from "../metrics.js";

test("metrics report zero conversion latency when no conversion has completed", () => {
  const metrics = getMetrics();
  assert.equal(metrics.conversions_total, 0);
  assert.equal(metrics.conversion_avg_ms, 0);
  assert.equal(metrics.conversion_min_ms, 0);
});

test("metrics count request types, errors, retries, and conversion durations", () => {
  const before = getMetrics();
  recordRequest("html");
  recordRequest("markdown");
  recordRequest("other");
  recordError("conversion");
  recordError("retry");
  recordError("rateLimit");
  recordRetrySuccess();
  recordConversionTime(12);
  recordConversionTime(18);
  const after = getMetrics();

  assert.equal(after.requests_total - before.requests_total, 3);
  assert.equal(after.requests_html - before.requests_html, 1);
  assert.equal(after.requests_markdown - before.requests_markdown, 1);
  assert.equal(after.errors_total - before.errors_total, 3);
  assert.equal(after.errors_conversion - before.errors_conversion, 1);
  assert.equal(after.errors_retry - before.errors_retry, 1);
  assert.equal(after.requests_rate_limited - before.requests_rate_limited, 1);
  assert.equal(after.retries_successful - before.retries_successful, 1);
  assert.equal(after.conversions_total - before.conversions_total, 2);
  assert.equal(after.conversion_avg_ms, 15);
  assert.equal(after.conversion_min_ms, 12);
  assert.equal(after.conversion_max_ms, 18);
  assert.ok(Number.isFinite(after.uptime_ms));
  assert.ok(Number.isFinite(Date.parse(after.timestamp)));
});

test("logMetrics emits structured JSON and returns the same snapshot", () => {
  const originalLog = console.log;
  const calls = [];
  console.log = value => calls.push(value);
  try {
    const snapshot = logMetrics();
    assert.deepEqual(JSON.parse(calls[0]), { type: "metrics", data: snapshot });
  } finally {
    console.log = originalLog;
  }
});
