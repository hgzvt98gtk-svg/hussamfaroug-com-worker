import assert from "node:assert/strict";
import test from "node:test";
import { compareBenchmarks, parseServerTiming, selectCheckpointLabel, statistics } from "../scripts/benchmark-utils.mjs";

test("statistics returns nearest-rank percentiles and null for no samples", () => {
  assert.deepEqual(statistics([1, 2, 3, 4]), {
    min: 1, max: 4, mean: 2.5, p50: 2, p90: 4, p99: 4
  });
  assert.equal(statistics([]), null);
});

test("Server-Timing parsing handles multiple stages, quoted commas, and invalid durations", () => {
  assert.deepEqual(parseServerTiming(
    'origin;dur=1.5;desc="fetch, headers", conversion;dur=12.25, conversion;dur=0, missing;desc="no duration", invalid;dur=-1'
  ), { origin: 1.5, conversion: 12.25 });
  assert.deepEqual(parseServerTiming(null), {});
});

test("scheduled checkpoints use elapsed days since the configured deployment time", () => {
  assert.equal(selectCheckpointLabel("2026-10-04T18:31:55Z"), "baseline");
  assert.equal(selectCheckpointLabel("2026-10-05T19:00:00Z"), "24h");
  assert.equal(selectCheckpointLabel("2026-10-06T19:00:00Z"), "48h");
  assert.equal(selectCheckpointLabel("2026-10-07T19:00:00Z"), "ongoing");
  assert.throws(() => selectCheckpointLabel("2026-10-04T18:00:00Z"), /after the deployment time/);
});

function result({ total = 100, conversion = 20, status = 200, errors = 0 } = {}) {
  return {
    success: errors === 0,
    fixtures: [{
      name: "10kb", path: "/", sourceHtmlBytes: 10_000, sourceSha256: "same",
      iterations: 20, warmups: 0, errors, statusCodes: [String(status)],
      timings: {
        total: { mean: total, p99: total, max: total },
        serverTiming: { conversion: { mean: conversion, p99: conversion, max: conversion } }
      },
      samples: [{ status, iteration: 1 }]
    }]
  };
}

test("comparison establishes a first successful fixture baseline without self-comparison", () => {
  const comparison = compareBenchmarks(result());
  assert.equal(comparison.passed, true);
  assert.equal(comparison.baselineEstablished, true);
  assert.equal(comparison.fixtureComparisons[0].compatible, false);
});

test("comparison flags absolute latency, greater-than-20-percent mean changes, and non-200s", () => {
  const baseline = result();
  const current = result({ total: 121, conversion: 20, status: 503 });
  const comparison = compareBenchmarks(current, baseline);
  assert.equal(comparison.passed, false);
  assert.ok(comparison.regressions.some(reason => reason.includes("HTTP 503")));
  assert.ok(comparison.regressions.some(reason => reason.includes("total mean is 21.00% worse")));

  const slow = compareBenchmarks(result({ total: 501, conversion: 501 }));
  assert.ok(slow.regressions.some(reason => reason.includes("total latency exceeded 500 ms")));
  assert.ok(slow.regressions.some(reason => reason.includes("conversion timing exceeded 500 ms")));
});

test("mean comparisons require the same source page bytes and content hash", () => {
  const current = result({ total: 150 });
  current.fixtures[0].sourceSha256 = "changed";
  const comparison = compareBenchmarks(current, result());
  assert.equal(comparison.fixtureComparisons[0].compatible, false);
  assert.equal(comparison.regressions.length, 0);
});

test("any request errors fail comparisons even when no HTTP status was returned", () => {
  const current = result({ status: 200, errors: 1 });
  current.fixtures[0].samples[0].status = null;
  const comparison = compareBenchmarks(current, result());
  assert.equal(comparison.passed, false);
  assert.ok(comparison.regressions.some(reason => reason.includes("error rate")));
});
