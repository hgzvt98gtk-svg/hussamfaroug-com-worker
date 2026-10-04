# Production readiness: benchmarks and audit findings

## Reproduction and scope

Measurements captured on 2026-10-04 with Node v22.23.3, Linux x64 and the existing
`html-rewriter-wasm@0.4.1` development dependency. Each scenario had three warmups
and **50 measured iterations**, sequentially, without concurrent tests.

```sh
npm ci
node scripts/benchmark-markdown.mjs --iterations 50
```

The script defaults to ten iterations, writes timestamped JSON, prints all stage
statistics, and compares compatible scenarios to `benchmarks/results-baseline.json`.
Use `--baseline PATH`, `--output PATH`, and `--label NAME` to select artifacts.
Writing directly to the baseline path establishes a baseline without comparing
it to itself. `benchmarks/results-optimized.json` records the after measurements
and baseline provenance. Both artifacts include source fingerprints.

The before snapshot has the destination-validation regex inside `mdRu`; the
after snapshot moves that same non-global/non-sticky regex to module scope.
All other converter behavior and benchmark fixtures are unchanged.

**These are local conversion-pipeline measurements, not production Worker
latency or CPU guarantees.** They include streamed input reading, negotiation,
conversion and byte-based token estimation. They exclude origin network/retry,
Worker response headers, edge scheduling, and native Cloudflare HTMLRewriter.
Total also includes fixture stream setup and converter preparation not attributed
to the two converter stages. Nearest-rank p99 with 50 observations is the maximum,
not a statistically stable production tail estimate. GC/JIT/runner noise remains.
Workers' clocks can be coarse or I/O-dependent; local Node stage timings must not
be equated with sampled synchronous-stage measurements in production.

## Results

Durations in milliseconds; negative delta means a lower after mean.

| Scenario | HTML bytes | Baseline mean | Baseline p99 | After mean | After p99 | Mean delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small, simple | 10,000 | 0.910 | 1.948 | 0.889 | 2.022 | -2.34% |
| Medium, links/lists/code/formatting | 100,000 | 43.514 | 57.510 | 44.369 | 55.183 | +1.97% |
| Large, simple, near 1 MiB limit | 1,000,000 | 34.130 | 43.345 | 34.859 | 43.463 | +2.14% |
| Nested, 128 wrapper levels | 54,647 | 18.281 | 19.836 | 17.834 | 19.645 | -2.45% |
| Long Accept, 400 extra ranges | 50,000 | 17.628 | 24.330 | 17.297 | 23.799 | -1.88% |

The long Accept header is 9,519 bytes. JSON artifacts contain min, max, mean,
p50, p90 and p99 for every stage, not just total.

### Baseline component means

| Scenario | Read HTML | HTMLRewriter | Markdown generation | Token estimate | Accept negotiation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 0.046 | 0.518 | 0.284 | 0.005 | 0.007 |
| Medium | 0.157 | 13.294 | 29.841 | 0.030 | 0.019 |
| Large | 0.931 | 16.359 | 15.743 | 0.219 | 0.016 |
| Nested | 0.093 | 6.900 | 11.141 | 0.019 | 0.014 |
| Long Accept | 0.092 | 6.689 | 10.556 | 0.020 | 0.152 |

Content complexity matters more than bytes alone: the 100 KB complex fixture
is slower than 1 MB simple HTML. The rewriter and Markdown generation dominate.
An exploratory 1 MB **complex** fixture run was stopped after more than four
minutes without a completed scenario summary; it is not represented by the
large/simple numbers above. That stress case needs dedicated profiling and a
native-runtime CPU-limit check before near-limit complex pages are considered
production-ready. No per-iteration timing or precise cause was established by
the interrupted run.

### Optimization decisions

- **Module-scope regex: implemented.** Mixed deltas between approximately -2.5%
  and +2.2% do not establish a reliable latency improvement. This removes a
  per-destination regex object allocation without changing URL validation;
  no fixed percentage gain is claimed. Earlier repeated runs also varied.
- **Array/join HTML reading: deferred.** Medium/complex read time is 0.36% of
  total; large/simple reading is 2.73%. The benchmark does not isolate
  concatenation from stream/decoder time, so the prerequisite “concatenation
  >2% of read latency” is unproven. Preserve byte-limit enforcement, cancellation,
  decoder streaming and split UTF-8 correctness until targeted profiling justifies
  a change. Small reads are about 5% of total but only 0.046 ms.
- **Deferred token counting: not warranted.** Token estimation consumes at most
  0.64% of total in these baseline scenarios, below the 5% gate. Moreover,
  `x-markdown-tokens` is a response contract, not merely a delayed metric.
  Moving estimation after response creation would require an explicit contract
  change and cannot preserve that header transparently.

For regression triage, rerun on the same environment and compare total **and**
stage distributions. A >10% p99 rise is an investigation signal, not an automatic
release verdict from one small sample. Increase iterations and repeat trials.

## Architecture and workspace audit

Source references below are relative to the repository root:
`/home/runner/work/hussamfaroug-com-worker/hussamfaroug-com-worker`.

### Primary data flows and coupling

1. The entrypoint records metrics, dispatches method handling, applies a
   per-isolate limiter, and serves generated discovery/robots/auth documentation
   before proxying. HEAD delegates to GET and strips/cancels the response body.
2. Proxy requests validate the configured origin, sanitize forwarding headers,
   request HTML, and perform an abortable fetch with bounded retries/timeouts.
   Non-HTML is streamed; HTML is either streamed through injection/CSP/header
   hardening or bounded/read/converted to Markdown with a token-estimate header.
3. Signing-directory requests use a separate KV-backed, single-flight,
   per-binding Ed25519 key cache. Only public JWK material is returned.
4. The import graph is acyclic: entrypoint → feature modules; metadata and
   bot-auth → response; response → discovery; proxy → metrics. No circular
   dependencies or SQL/database queries were found.
5. `response.js:1,5–11,99–114` mixes low-level encoding, security headers,
   discovery markup and WebMCP. Bot-auth imports only its encoder but thereby
   depends on the response/discovery bundle. Splitting encoding utilities is
   a low-priority boundary improvement, not a demonstrated runtime bottleneck.
6. `proxy.js:1,85–103` directly mutates singleton telemetry; metrics and rate
   limiting are isolate state shared across invocations. Tests must isolate
   rate-limit buckets and compare metric deltas rather than assume fresh counters.

### Security review

A read-only specialist reviewed the nine production modules, scripts, tests,
dependency manifests, deployment configuration and documentation; `.github/agents`
was excluded. **No high-confidence exploitable vulnerability or committed
production secret was identified.** This is not a guarantee of security.

The multi-CSP regression exposed a correctness gap in the existing single-policy
parser: appended origin policies were not augmented independently. The fix in
`response.js:55–72` preserves separate policies and adds the same nonce and
Cloudflare source to each effective script directive rather than unioning
policies. `test/hardening.test.mjs:180–219` covers script-src, script-src-elem,
default-src fallback and preservation of non-script restrictions.

Important boundaries: origin URLs stay confined to configured HTTP(S) origins,
redirects are manual, HTML reads are bounded, cancellation propagates, and
application failure logs omit request URLs/private keys. Custom identity inputs
outside the enumerated cache list remain an **origin/CDN configuration risk**,
not a proven exploit against the current public static origin. README now
documents private/no-store and warns that arbitrary Vary values are not
automatically honored by Cloudflare cache keys.

Live routes, KV contents, WAF/CDN rules, external log retention, native CPU limits
and actual alert delivery were not audited. Phase 1 verification remains with
the operator. No external monitoring service or alert destination was provisioned.

### Prioritized follow-up recommendations

| Priority | Evidence | Recommendation |
| --- | --- | --- |
| High | `markdown.js:142–214`; complex stress case above | Profile pathological complex documents in the native runtime before considering regex/parser or generated-string changes; the 1 MiB cap is not a CPU budget. Preserve converter safety tests. |
| High | `metadata.js:71–96` | Resolve the existing advertisement of nonfunctional OAuth endpoints with the separate authentication/discovery workstream. Do not invent registration, token, claim or revocation services. This patch intentionally does not alter that contract. |
| High | `metrics.js:29–38,66–95`; monitoring guide | Establish request-level status/latency ingestion and reliable isolate identity before enabling alerts or globally summing counters. Means and cumulative sums cannot produce p99 or exact two-minute outage ratios. |
| Medium | `hussamfaroug-com-worker.js:37–39,127`; `proxy.js:7–23` | Reuse one Accept-negotiation result per invocation if production profiles justify it; it is currently parsed for classification and again for HTML representation selection. Benchmark negotiation alone does not include both Worker calls. |
| Medium | `rate-limit.js:23–28` | Profile full-map pruning under sustained distinct-client churn; scanning up to 10,000 entries can recur at capacity. Keep Cloudflare WAF as the globally enforced control. |
| Low | `response.js:1–11`; `bot-auth.js:1` | Separate byte encoding from response/discovery concerns if those modules grow. |
| Low | `scripts/benchmark-markdown.mjs:22–48`; `test/worker.test.mjs:22–55` | Consider sharing the Node/WASM adapter when parser-support maintenance warrants it. It is dev-only duplication, not production dead code. |
| Low | `scripts/verify-deployment.mjs:124–145` | Keep smoke-check labels distinct from actual retry, rate-limit, metrics and latency verification; operational guides now clarify their limits. |

No production helper was proven unreachable or redundant enough to delete.
Test-only exports such as `resetRateLimits` and the CSP helpers are intentionally
used. Avoid speculative removal or a broad refactor without profiling evidence.

## Validation and operator work

Baseline tests passed (103 tests); implementation regression tests passed
(109 tests), including sampled/unsampled timings, HEAD behavior, stage profiling,
timing input validation, origin counters and multi-policy CSP. The repository
defines no separate lint/build command. Secret scanning and automated
review/security checks are part of the PR validation.

Before rollout, complete the manual deployment checklist in
[OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md), validate logging/ingestion and
configure alert rules using [MONITORING_SETUP.md](MONITORING_SETUP.md).
Passing local tests and benchmarks does not establish production readiness.
