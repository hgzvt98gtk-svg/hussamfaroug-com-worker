import assert from "node:assert/strict";
import test from "node:test";
import { getMetrics, logMetrics, recordConversionTime, recordError, recordRequest, recordRetrySuccess, recordTiming } from "../metrics.js";

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

test("component timings include sample counts and ignore invalid measurements", () => {
  const before = getMetrics();
  for (const [component, field] of [
    ["origin", "timingOrigin"], ["readHtml", "timingReadHtml"], ["conversion", "timingConversion"],
    ["headers", "timingHeaders"], ["tokens", "timingToken"]
  ]) {
    recordTiming(component, 2.5);
    recordTiming(component, 0);
    for (const invalid of [-1, NaN, Infinity, "10"]) recordTiming(component, invalid);
    const after = getMetrics();
    assert.equal(after[field + "_ms"] - before[field + "_ms"], 2.5);
    assert.equal(after[field + "_samples"] - before[field + "_samples"], 2);
  }
  const snapshot = getMetrics();
  for (const component of ["unknown", "__proto__", "constructor"]) recordTiming(component, 5);
  const after = getMetrics();
  for (const field of Object.keys(snapshot).filter(key => key.startsWith("timing"))) assert.equal(after[field], snapshot[field]);
  assert.equal(after.timing_sample_rate, 0.01);
});

test("origin status failures and terminal fetch failures have distinct counters", () => {
  const before = getMetrics();
  recordError("origin");
  recordError("retry");
  const after = getMetrics();
  assert.equal(after.errors_origin - before.errors_origin, 1);
  assert.equal(after.errors_origin_fetch - before.errors_origin_fetch, 1);
  assert.equal(after.errors_total - before.errors_total, 2);
});
