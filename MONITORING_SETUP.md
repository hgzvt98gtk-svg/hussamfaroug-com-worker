# Monitoring setup

## What exists, and what must be configured

The Worker emits structured application metrics to console logs and generic
failure/retry messages. There is no public metrics endpoint, scheduled metrics
flush, Analytics Engine binding, Prometheus exporter, external collector, or
alert webhook in this repository. This guide specifies **setup to perform**,
not services already provisioned. Owner/contact: **admin@hussamfaroug.com**.

The deployment workflow attempts to enable Cloudflare observability with logs,
invocation logs, traces, persistence, query-string redaction, and head sampling.
Validate the deployed settings, permissions, retention, and actual incoming
records in Cloudflare. Application component sampling is separate from platform
log sampling.

## Application metrics contract

Each metrics console entry is JSON with `type: "metrics"` and a `data` object.
Values are cumulative for **one live Worker isolate**, not global site totals.
Emission is triggered by a request after either 1,000 additional requests or
five minutes since the last log. There is **no idle timer**: a quiet isolate may
not log for much longer than five minutes, and shutdown can lose its unflushed
tail. Logging at request entry can include that request before its eventual
error/conversion is recorded. Therefore snapshots are diagnostic, not precise
five-minute response-status accounting.

| Fields | Meaning and limitations |
| --- | --- |
| `timestamp`, `uptime_ms` | Snapshot time and isolate lifetime; not request latency. |
| `requests_total`, `requests_html`, `requests_markdown` | Cumulative invocation/Accept classifications, not counts of successfully produced representations. Total also includes other methods. |
| `requests_rate_limited` | Cumulative limiter rejections; not a globally enforced quota. |
| `errors_total` | Recorded error categories, including rate limiting and configuration; **not HTTP 5xx count**. Some failures, such as signing-directory errors, are not represented by it. |
| `errors_origin` | Upstream HTTP 5xx responses, including statuses other than 502. |
| `errors_origin_fetch` | Exposed `retryFailures` counter: terminal retried network fetch failures, including timeout/cancellation paths that reach terminal retry failure. Not every cancellation, body-stream failure, or final edge 502 is counted. |
| `errors_retry` | Compatibility alias of `errors_origin_fetch`; do not add the two together. |
| `errors_conversion` | HTML read/conversion failure category; not solely converter exceptions. |
| `retries_successful` | Fetches that succeeded after retry; does not imply HTTP success or successful body completion. |
| `conversions_total`, `conversion_avg_ms`, `conversion_min_ms`, `conversion_max_ms` | All recorded conversion attempts and lifetime timing aggregates. Average is rounded; min/max are lifetime extrema. None is p99 or a complete-request duration. |
| `timingOrigin_ms`, `timingOrigin_samples` | Cumulative sampled origin-fetch duration sum and count, including measured retry work; not complete response streaming time. |
| `timingReadHtml_ms`, `timingReadHtml_samples` | Cumulative sampled HTML body-read duration sum and count. |
| `timingConversion_ms`, `timingConversion_samples` | Cumulative sampled conversion duration sum and count. |
| `timingHeaders_ms`, `timingHeaders_samples` | Cumulative sampled measured header-processing duration sum and count. |
| `timingToken_ms`, `timingToken_samples` | Cumulative sampled token-estimation duration sum and count; token header itself estimates bytes/4, not model-specific tokenization. |
| `timing_sample_rate` | Configured component sampling probability, currently `0.01`; not a guarantee of actual sample coverage. |

Component timing is selected at random for approximately **1% of requests**.
Only stages actually reached/measured contribute their own sums and counts.
Sampling is not guaranteed to select every hundredth request. Stage counts can
differ, and rare paths/short windows may have no samples. The `_ms` fields are
**sums**, never individual durations or percentiles. Do not graph them directly
as response latency or sum their averages into an end-to-end p99.

### Reset-safe ingestion and interval calculations

1. Parse only validated `type: "metrics"` records and retain numeric fields,
   Worker version, record timestamp, and available platform stream metadata.
2. Establish a reliable per-isolate stream identity before differencing. The
   JSON does not itself provide a unique isolate ID; version, colo, and an
   approximate start time (`timestamp - uptime_ms`) alone can collide. If the
   log source cannot identify streams reliably, do not invent global rates from
   these snapshots; use edge request/status logs instead.
3. Sort records within a stream, reject duplicates and out-of-order records,
   and use the first observation only as a baseline. Start a new baseline on
   deployment, isolate replacement, decreasing uptime/counters, or inconsistent
   identity. Never subtract values from different isolates or clamp resets to
   manufacture traffic.
4. For a monotonic counter `C`, interval count is `current.C - previous.C`.
   For each timing pair, interval mean is
   `(current.sum_ms - previous.sum_ms) / (current.samples - previous.samples)`,
   only with nonnegative deltas and positive sample-count delta. Zero samples
   means unavailable, not zero latency.
5. Aggregate compatible interval sums and counts across identified streams
   before dividing. Do not average averages. Do not sum cumulative snapshots,
   difference min/max, or derive an exact interval conversion sum from the
   rounded lifetime `conversion_avg_ms`.
6. Label results with the actual observation interval and coverage. Sparse logs
   spanning ten minutes cannot accurately resolve a two-minute outage.

Restarts, idle isolates, dropped logs, and ingestion delay make deltas
incomplete. None of these aggregates supports percentile reconstruction.

## Configure telemetry sources

### Cloudflare platform

1. Open Workers → `hussamfaroug-com` → observability/logging settings using a
   least-privilege authorized account. Enable the required logs/traces and
   choose retention appropriate to incident response and privacy requirements.
2. Send low-volume HTML, Markdown GET, and signing-directory probes. Confirm
   timestamps, deployed version, console JSON (when its trigger is reached),
   request outcomes, and platform records. Do not generate 1,000 production
   requests simply to force a metrics snapshot.
3. Select an available Cloudflare edge HTTP request log dataset/export that
   contains **final response status** and actual **wall-clock request duration**.
   Verify field definitions and units in that dataset; invocation outcome
   (`ok`/exception), Worker CPU time, and origin-only time are not replacements.
4. Verify whether duration ends at headers or full body completion, especially
   for streamed HTML. Use one documented latency definition consistently.
   Partition dashboards by version, region, path class, and representation when
   those attributes are safely available.
5. Confirm completeness/sampling and delivery delay against known requests.
   If only sampled logs are available, expose coverage, apply documented
   weights when supported, and do not label estimated ratios exact. Disable
   paging rules until their required source and coverage have been validated.

### Optional external integrations

- **Prometheus/Grafana:** configure an operator-managed collector to receive
  supported Cloudflare exports, validate records, handle stream resets, and
  expose safe interval aggregates/histograms. Prometheus cannot scrape a
  nonexistent Worker `/metrics` route. Grafana is visualization, not a source
  of missing request-level latency.
- **Datadog or another hosted backend:** configure a supported Cloudflare log
  integration/export and map verified status/duration fields. Build percentiles
  from individual durations or compatible histograms, not component sums.
- **Cloudflare Analytics Engine:** optional future instrumentation requiring a
  separately provisioned dataset/binding and code changes; none is configured.
- **Notifications:** explicitly configure and test the chosen email/pager/chat
  destination and escalation policy. Keep webhook URLs/tokens in the backend's
  secret store; no webhook URL or notification service is supplied here.

Use existing platform capabilities; no additional Worker/package dependency
is required by this guide. Grant only export/query permissions needed and
exclude credentials, sensitive query strings, and bodies. Keep label cardinality
bounded; avoid client IP, full URL, or arbitrary header labels.

## Initial alert definitions

These are initial operational thresholds, not proven service guarantees. Use
rolling windows ending at the latest complete ingestion watermark, restricted
to this service and the agreed production route. Suppress duplicate pages and
send recovery only after a complete healthy window.

Use at least **100 observed completed requests** per ratio window (including
the two-minute window). Require at least **1,000 valid request-duration samples**
per p99 window. These are starting low-volume guards: tune with production
traffic. If volume or coverage is insufficient, mark the rule **insufficient
data**, not healthy; use separately configured low-rate availability probes
and investigation instead. Platform sampling may require stricter guards.

| Alert | Window / condition | Authoritative provenance and denominator |
| --- | --- | --- |
| Elevated 5xx | 5 minutes, `100 × count(status 500–599) / count(all completed requests) > 1` | Final edge HTTP status logs. Never `errors_total / requests_total`. |
| Elevated rate limiting | 5 minutes, `100 × count(status 429) / count(all completed requests) > 5` | Final edge HTTP status logs; use limiter deltas only as a diagnostic cross-check. |
| High request latency | 5 minutes, actual request-duration p99 >500 ms | Verified per-request wall-clock durations or mergeable latency histograms; use backend quantile calculation. Never lifetime means/maxima, CPU time, or cumulative component sums. |
| Origin-related 502 outage | 2 minutes, `100 × count(confirmed origin-related final 502) / count(all completed requests) > 50` | Final edge 502 logs correlated with request-specific origin/network failure evidence or platform origin tracing. Denominator is all completed requests, **not** only 502 responses. |

The last alert requires attribution that separates upstream 502 and failed
origin fetches from converter/read-limit 502s. Generic error console messages
can help only when the platform links them to the same invocation and final
status. `errors_origin` includes all upstream 5xx; `errors_origin_fetch` is a
terminal retry counter and may include cancellations. Neither yields an exact
origin-related 502 ratio, and their sum is not a valid substitute. If correlation
is unavailable, leave this origin-specific rule unconfigured and use the
general 5xx rule plus manual triage. Five-minute request-triggered snapshots
cannot support an exact two-minute alert.

Keep a separate dashboard for HTML/Markdown p99, with **100 ms / 300 ms starting
targets**, clearly labeled as provisional baselines rather than guarantees.
Do not apply those targets to component timing means.

## Dashboard and commissioning checklist

- Request volume and final-status distribution: 2xx, 3xx, 4xx, 429, 5xx, and 502.
- Actual latency p50/p95/p99 by safe path class, version, and representation;
  show units, sample count, latency definition, and coverage.
- Reset-safe limiter, origin, retry, and conversion error deltas; separate
  terminal fetch failures from upstream HTTP failures.
- Component interval means with sample counts; all-conversion lifetime
  average/min/max labeled as diagnostics, not interval percentiles.
- Deployment annotations, log/export lag, missing-data state, and signing
  directory availability. Do not assume signing failures appear in errors_total.

Before enabling paging, validate ingestion/schema using known requests; test
rules with synthetic backend data or staging faults, not live production floods.
Verify the low-volume/reset/missing-data guards, origin attribution, notification
delivery, ownership acknowledgement, and recovery behavior. Record evidence
and chosen retention/thresholds in the monitoring backend's configuration.

After deployment run:

```bash
node scripts/verify-deployment.mjs
```

This checks public endpoint health, **not** metrics delivery, alert activation,
or request latency percentiles. Confirm those independently in the backend.
Follow [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) for incident triage,
signing-key cache/propagation caveats, cache policy checks, and rollback.
