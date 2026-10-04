# Phase 1.1 — Markdown performance profiling

## Executive summary

**Bottleneck identified: YES. No Phase 2 optimization was performed.**

The primary bottleneck on well-formed, complex HTML is the final protected-text
restoration: `join()` repeatedly concatenates an accumulated string while checking
`text.endsWith("`")`. The reduction callback at `markdown.js:136` accounts for
**69.92% of sampled worker time**; garbage collection accounts for **20.84%**.
This is strong evidence of repeated string copying/flattening and allocation
pressure, not exponential regex backtracking, for this fixture.

The representative 1,000,000-byte complex fixture:

- Hit the default **15-second per-conversion watchdog**, during `restore` in its
  first diagnostic warmup.
- Completed with a 60-second watchdog: individual measured conversions took
  **17.27–33.28 seconds**, averaging **19.92 seconds**.
- Took **251.68 seconds overall** in the profiled worker (three warmups plus ten
  measured conversions). A four-minute *profiling batch* is reproduced; a single
  conversion exceeding four minutes is **not** reproduced.

The historical scan's exact input/runtime/logs were not supplied. These results
identify a reproducible current bottleneck, not proof that its historical timeout
was one conversion or that Cloudflare has identical timings.

Secondary findings:

1. Unclosed headings, formatting elements, and titles exhibit approximately
   quadratic regex rescanning. Unclosed title matching occurs **before** the
   existing component timers, making its cost appear as “other.”
2. The Node WASM adapter also scales poorly with many rewritten links. The CPU
   profile identifies Node stream queue removal as a secondary hotspot, not a
   native Cloudflare HTMLRewriter finding.
3. No stack overflow occurred at 128 div levels or 512 nested strong elements.
   Deep HTML nesting is not equivalent to equally deep `containerText()` recursion.

## Environment and method

- Run date: 2026-10-04.
- Node.js **v22.23.3**, Linux x64.
- `npm ci`: eight packages installed; audit reported zero vulnerabilities.
- Existing dependency: `html-rewriter-wasm@0.4.1`; no dependencies added.
- Existing test suite: **120 tests passed**, including one new diagnostic parity
  test. No existing lint/build commands are defined in `package.json`.
- Original command: `node scripts/profile-markdown.mjs`.
  All four original fixtures failed warmup with `HTMLRewriter is not defined`;
  the original script nevertheless exited successfully with an empty summary.
- Harness now uses the same Workers API adapter as
  `scripts/benchmark-markdown.mjs`, reports actual UTF-8 byte counts, and isolates
  each fixture in a worker thread. A main-thread timer can terminate synchronous
  regex/string work; an in-worker timer alone could not interrupt it.
- Three **instrumented warmups** per fixture; subsequent measured conversions
  omit the detailed diagnostic callback. Ten measured conversions per fixture,
  except original large (three) and original complex (five).
- Detailed events use an optional fourth `convertMd` argument, separate from the
  existing `rewriter`/`markdown` timing callback. No HTML content is logged.
- Total time covers `convertMd`; “other” is total minus rewriter minus generation.
  Network, Worker headers, request negotiation, token counting, and fixture
  construction are excluded.
- Independent full-suite and 1 MB CPU-profile runs overlapped in the sandbox.
  CPU profiling, cold WASM initialization, GC, and shared CPU affect timings.
  Treat these as diagnostic observations, not production percentiles or precise
  cross-environment benchmarks. Ten samples do not establish a useful p99.

## Conversion timings

All values are milliseconds. Component columns are arithmetic means; range is
the observed minimum–maximum total. “Original” preserves the supplied fixture
contents, not its inaccurate size label.

| Fixture | Actual bytes | Runs | Total mean | Total range | HTMLRewriter | Markdown | Other |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| Original small (“10 KB”) | 1,659 | 10 | 1.162 | 0.871–1.997 | 0.892 | 0.212 | 0.058 |
| Original medium (“100 KB”) | 76,694 | 10 | 25.729 | 21.500–40.494 | 8.115 | 17.501 | 0.113 |
| Original large (“1 MB”) | 469,698 | 3 | 278.014 | 270.677–288.383 | 23.654 | 254.109 | 0.251 |
| Original complex (“50+ KB”) | 91,858 | 5 | 45.802 | 38.928–52.070 | 23.927 | 21.760 | 0.115 |
| Complex, 128 div levels | 50,000 | 10 | 26.655 | 21.500–35.342 | 12.021 | 14.539 | 0.095 |
| Complex, 128 div levels | 100,000 | 10 | 54.495 | 49.579–67.136 | 19.356 | 35.025 | 0.113 |
| Complex, 128 div levels | 500,000 | 10 | 3,945.805 | 3,839.470–4,150.806 | 311.996 | 3,633.657 | 0.152 |
| Complex, 128 div levels, CPU-profiled rerun | 1,000,000 | 10 | 19,915.790 | 17,270.753–33,283.092 | 1,531.108 | 18,384.539 | 0.143 |
| 32 nested strong elements | 1,059 | 10 | 0.726 | 0.457–1.245 | 0.512 | 0.166 | 0.048 |
| 128 nested strong elements | 4,255 | 10 | 1.244 | 0.616–2.151 | 0.808 | 0.374 | 0.062 |
| 512 nested strong elements | 17,311 | 10 | 2.503 | 2.246–2.998 | 1.060 | 1.389 | 0.054 |
| Unclosed headings | 50,000 | 10 | 87.833 | 86.193–89.880 | 5.335 | 82.421 | 0.077 |
| Nested closed headings | 50,000 | 10 | 15.022 | 12.126–24.181 | 5.821 | 9.125 | 0.076 |
| Special-character links | 50,000 | 10 | 26.834 | 25.998–29.217 | 20.004 | 6.752 | 0.078 |
| Unclosed strong elements | 50,000 | 10 | 38.597 | 37.230–39.386 | 3.797 | 34.748 | 0.052 |
| Unclosed titles | 50,000 | 10 | 72.908 | 72.401–73.889 | 1.105 | 0.855 | 70.948 |
| Unclosed headings | 100,000 | 10 | 338.164 | 335.751–340.655 | 10.207 | 327.869 | 0.088 |
| Nested closed headings | 100,000 | 10 | 27.983 | 25.900–34.381 | 10.126 | 17.769 | 0.088 |
| Special-character links | 100,000 | 10 | 142.420 | 89.808–213.953 | 123.614 | 18.698 | 0.107 |
| Unclosed strong elements | 100,000 | 10 | 139.421 | 138.309–140.621 | 7.341 | 132.011 | 0.070 |
| Unclosed titles | 100,000 | 10 | 287.087 | 286.064–289.152 | 1.917 | 1.426 | 283.744 |
| Unclosed headings | 500,000 | 10 | 8,440.581 | 8,192.030–8,877.329 | 53.241 | 8,387.233 | 0.107 |
| Nested closed headings | 500,000 | 10 | 299.421 | 249.198–386.136 | 58.652 | 240.645 | 0.123 |
| Special-character links | 500,000 | 10 | 5,771.669 | 5,708.134–5,832.107 | 4,094.175 | 1,677.346 | 0.148 |
| Unclosed strong elements | 500,000 | 10 | 3,668.766 | 3,447.303–4,461.617 | 36.312 | 3,632.337 | 0.118 |
| Unclosed titles, isolated rerun | 500,000 | 10 | 7,271.665 | 7,180.153–7,320.974 | 7.576 | 13.518 | 7,250.571 |

### Watchdogs and errors

- Default repaired run: 1 MB complex timed out in warmup 1 at `restore` after
  15,000 ms. No complete component durations are invented for this censored run.
- 500 KB unclosed titles completed warmups and four measured iterations, then
  iteration 5 exceeded 15,000 ms while the other profiling run was active.
  Measured iterations omit diagnostic events, so the timeout log cannot identify
  the precise live function; preceding warmups identify title matching as dominant.
  An isolated rerun with a 60-second watchdog is reported below.
- An initial repaired-harness experiment bounded the *whole fixture batch* at
  15 seconds, incorrectly censoring several fixtures whose individual conversions
  completed. Its results are superseded by the per-conversion watchdog and are
  not used in the table.
- No stack overflow or conversion exception was observed in the repaired runs.

## Exact 1 MB measured samples

These samples include CPU-profiler overhead, but not detailed diagnostic events.

| Iteration | Total | HTMLRewriter | Markdown | Other |
| --- | ---: | ---: | ---: | ---: |
| 1 | 19,068.463 | 1,666.404 | 17,401.843 | 0.216 |
| 2 | 18,741.649 | 1,251.379 | 17,490.185 | 0.084 |
| 3 | 18,244.819 | 1,195.598 | 17,049.128 | 0.092 |
| 4 | 18,071.176 | 1,211.960 | 16,859.092 | 0.124 |
| 5 | 18,650.867 | 1,223.026 | 17,427.726 | 0.116 |
| 6 | 18,720.722 | 1,242.158 | 17,478.246 | 0.318 |
| 7 | 18,925.578 | 1,338.417 | 17,587.015 | 0.145 |
| 8 | 17,270.753 | 1,283.400 | 15,987.236 | 0.116 |
| 9 | 18,180.782 | 1,311.819 | 16,868.869 | 0.094 |
| 10 | 33,283.092 | 3,586.919 | 29,696.045 | 0.128 |

## Detailed evidence

### Well-formed complex fixture: per-pass diagnostics

Values below are mean inclusive durations across three instrumented warmups,
not the uninstrumented means above. Nested scopes overlap: **do not sum columns**.
`restore` includes the final `join`; aggregate `join` also includes tiny calls
inside anchors, code, and containers.

| Stage | 50 KB | 100 KB | 500 KB | 1 MB |
| --- | ---: | ---: | ---: | ---: |
| Title match | 0.073 | 0.075 | 0.102 | 0.137 |
| HTMLRewriter | 27.932 | 47.217 | 467.890 | 1,774.004 |
| Main/body selection | 0.125 | 0.180 | 0.400 | 0.990 |
| Heading replace | 2.685 | 4.863 | 16.099 | 37.857 |
| Pre replace | 1.938 | 3.542 | 15.459 | 29.056 |
| Code replace | 0.092 | 0.132 | 0.377 | 0.372 |
| Blockquote replace | 0.089 | 0.099 | 0.277 | 0.278 |
| Anchor replace | 1.440 | 2.212 | 9.655 | 18.303 |
| List replace (including item matching) | 2.208 | 3.456 | 16.876 | 45.860 |
| Format replace | 3.765 | 7.772 | 25.788 | 61.447 |
| All containerText calls | 6.139 | 11.011 | 39.133 | 92.457 |
| All container anchor replaces | 0.776 | 1.108 | 3.997 | 10.867 |
| All container format replaces | 0.562 | 1.289 | 4.124 | 7.959 |
| All mdStripTags calls | 1.786 | 2.675 | 10.430 | 26.569 |
| All mdDec calls | 2.268 | 3.608 | 16.755 | 42.416 |
| All join calls | 7.155 | 22.031 | 3,443.204 | 15,424.426 |
| Final restore | 7.134 | 22.017 | 3,444.281 | 15,426.240 |

At 1 MB, each warmup invokes `containerText` 26,104 times, `mdStripTags`/`join`
39,157 times, and `mdDec` 45,683 times. None is individually slow except the
large final join. Recursion work remains small relative to restoration.

Final restoration grows from 22 ms at 100 KB to 3,444 ms at 500 KB, and 15,426 ms
at 1 MB. It is strongly superlinear; the 500 KB→1 MB increase is about 4.5× for
2× bytes. Memory/GC thresholds make a single simple complexity fit inappropriate,
but repeated copying of growing prefixes predicts approximately quadratic work
when marker count grows with input length. **No evidence establishes exponential
growth on well-formed complex input.**

### V8 CPU profile

The worker CPU profile covered 251.675 seconds, including all warmups and samples.
Weights were calculated by summing `timeDeltas` for each sampled node:

| Sampled location | Weighted share |
| --- | ---: |
| `join` reduction callback, `markdown.js:136` | 69.92% |
| Garbage collector | 20.84% |
| Node `dequeueValue`, `node:internal/webstreams/util:128` | 6.78% |
| `convertMd` frame | 0.31% |
| `mdDecImpl` | 0.10% |

The main-thread profile is 99.96% idle: conversion runs in the isolated worker.
Inspecting only the supervisor profile would miss the bottleneck.

The join callback concatenates growing strings and immediately queries their
suffix on every step. V8 may flatten the concatenated representation to answer
that query, then repeat for the next prefix. The hot line plus substantial GC
supports this mechanism; the profile does not separately attribute native
allocation versus `endsWith` internals.

### Regex and recursion analysis

Mean diagnostic durations, milliseconds:

| Target | 50 KB | 100 KB | 500 KB | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Heading replace on unclosed `<h1>` | 81.545 | 327.600 | 8,174.176 | ~4× on doubling; ~25× on 5× growth |
| Format replace on unclosed `<strong>` | 33.960 | 130.887 | 3,494.151 | Approximately quadratic |
| Title match on unclosed `<title>` | 71.608 | 283.628 | 7,311.772 | Cost lies outside existing component timers |
| Anchor replace on special-character links | 7.473 | 11.460 | 46.606 | No dominant anchor backtracking observed |

Repeated opening tags without closing tags make each lazy content matcher scan
the remaining suffix and fail before another candidate opening tag is tried.
The sum of these suffix lengths is quadratic. The nested, *closed* heading case
does not trigger that failure mode: measured totals are 15, 28, and 299 ms;
restoration is a growing share at 500 KB.

`tagAttrs` separates quoted/unquoted alternatives; the anchor pattern additionally
uses a quote backreference and competing attribute/content searches. The parser
normalizes anchors and strips other attributes before this regex runs
(`markdown.js:190–196`). The special-link fixture exercises quoted attributes,
entities and link punctuation through that real pipeline; its 500 KB rewriter
cost is ~4.09 seconds versus ~47 ms for the diagnostic anchor pass. This is not
proof that every malformed anchor is safe, but does not support blaming this
regex for the representative complex fixture.

The format disjunction's normal matched cases are cheap relative to final join;
missing closing tags produce the separate rescanning issue above.
For 32/128/512 nested strong tags, diagnostics record only **two containerText
calls per conversion**. The regex matches the first same-tag close rather than
faithfully walking all HTML ancestors. These inputs therefore disprove a
512-frame recursion explanation for this case, not all possible recursion risks
or correct rendering of arbitrarily nested HTML.

## Reproduction

Run from `/home/runner/work/hussamfaroug-com-worker/hussamfaroug-com-worker`:

```bash
npm ci
node scripts/profile-markdown.mjs
PROFILE_FILTER=complex-1000000 PROFILE_TIMEOUT_MS=60000 \
  node --cpu-prof --cpu-prof-dir=/tmp scripts/profile-markdown.mjs
PROFILE_FILTER=unclosed-headings node scripts/profile-markdown.mjs
PROFILE_FILTER=unclosed-titles-500000 PROFILE_TIMEOUT_MS=60000 \
  node scripts/profile-markdown.mjs
```

`PROFILE_FILTER` is a fixture-key substring, not a regex. The watchdog covers each
warmup/measurement separately, plus startup; timeouts are explicitly reported
and the suite continues. Conversion errors produce a nonzero exit status;
expected diagnostic timeouts alone do not.

The committed script is the deterministic fixture source:

- Complex units repeat a heading, paragraph with strong/emphasis/link, list item,
  and pre/code block. The unit is taken from the existing benchmark generator.
  A title/body/main envelope and 128 div wrappers surround complete units; space
  padding gives exact 50,000/100,000/500,000/1,000,000-byte ASCII documents.
- Unclosed headings repeat `<h1>text`; unclosed formatting repeats
  `<strong>text`; unclosed titles repeat `<title>text` **without** a preceding
  valid title, otherwise the first title would hide the failed-match case.
- Nested heading units are `<h1><h2><h1>text</h1></h2></h1>`.
- Special links repeat `<a href="/page?q=&amp;&quot;x">text &amp; *</a>`.
- Nested formatting wraps text in 32/128/512 strong tags with distinct
  `data-level` attribute values.

Console output includes every measured iteration's total and component durations,
aggregate min/max/mean, and diagnostic call counts/aggregate/max durations.
CPU profiles are deliberately written to `/tmp`, not committed.

## Phase 2 recommendations (not implemented)

1. **Prioritize final restoration/join.** Eliminate repeatedly examining/copying
   the accumulated prefix while preserving the backtick-boundary separator,
   protected destinations, entity ordering, and final angle-bracket escaping.
   Benchmark output-equivalent changes against these exact fixtures.
2. **Address failed closing-tag searches separately.** Consider bounded/tokenized
   extraction or a parser-backed conversion strategy. Include unclosed titles,
   headings and formatting, not just well-formed documents. Do not infer safety
   from one regex rewrite or impose silent content truncation.
3. **Expose title/extraction time in future request observability.** Current
   component metrics miss work performed before `rewriterStartedAt`.
4. **Verify in native Cloudflare Workers before architecture changes.** Node's
   WASM/Response stream queue behavior is a measurable secondary bottleneck.
   Keep it distinct from the production converter's join hotspot.
5. **Establish separate per-conversion and batch budgets.** Retain watchdog-based
   profiling and regression coverage; do not confuse 13 repeated conversions
   with one four-minute request. No performance optimization or unrelated
   operational/WAF/CSP changes belong in this phase.

## Validation

- Existing suite plus diagnostic output-parity/stage-balance test: 120/120 passed.
- `git diff --check`: passed.
- Secret scan of modified code: no secrets detected.
- CodeQL JavaScript scan: zero alerts.
- Automated review could not run because its configured model was unavailable;
  a separate read-only reviewer found no significant issues. This is an infrastructure limitation,
  not a successful automated review.
