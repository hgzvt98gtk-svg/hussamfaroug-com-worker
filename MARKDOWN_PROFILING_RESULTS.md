# Markdown Conversion Performance Profiling — Phase 1.1

## Executive summary

The measured data does **not** confirm `mdDec()` as the primary bottleneck. On a
500,000-character complex fixture, it accounted for 4.922 ms (0.31%) of a
1,595.752 ms conversion; the Markdown generation stage took 1,571.526 ms
(98.48%). The decoder was called 6,117 times, not the previously asserted
48,381 times.

Combining the seven decoder replacements into one callback-based regex was
slower in this benchmark: 63.067 ms versus 44.657 ms for seven sequential
passes (0.71x speedup, i.e. the combined version took 1.41x as long). No
15-second timeout was reproduced for any tested fixture through 600 KB, so no
minimal failing input or timeout threshold was found. The earlier timeout
observations remain unverified by this run.

These results complete the requested measurements, but they do not identify
the expensive operation *within* Markdown generation. Phase 2 should profile
that stage before choosing an optimization.

## Measurement environment and reproduction

Measurements were taken on 2026-10-04 with Node v22.23.3 on Linux x86_64 and
the repository's locked `html-rewriter-wasm@0.4.1` dependency. The benchmark
scripts are standalone:

```sh
npm ci
node scripts/profile-mddec-isolated.mjs
node scripts/profile-regex-passes.mjs
node scripts/find-minimal-reproducer.mjs
```

The isolated decoder benchmark warms each input 20 times, then measures 1,000
calls. The regex benchmark warms each operation five times, then measures 100
iterations on a 50,000-character entity-heavy string. The reproducer runs each
conversion in a child process with a 15-second timeout, warming it with a
25 KB fixture first. All tested fixtures are ASCII, so their character and byte
counts match. Measurements are local Node/WASM results, not Cloudflare Worker
CPU or latency guarantees; timings may vary with runtime and host load.

`mdDec` timing collection is opt-in through `resetMdDecStats()` and can be read
with `getMdDecStats()` or disabled with `disableMdDecStats()`. Statistics are
not collected unless explicitly enabled. The optional statistics API is global
to the module and intended for sequential profiling, not concurrent requests.

## 1. Isolated `mdDec()` performance

| Input size | Calls | Total (ms) | Average (ms/call) | Average-time ratio vs previous | Effective exponent |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small (50 B) | 1,000 | 2.645 | 0.002645 | — | — |
| Medium (500 B) | 1,000 | 6.527 | 0.006527 | 2.47x | 0.39 |
| Large (5,000 B) | 1,000 | 50.707 | 0.050707 | 7.77x | 0.89 |
| Very large (50,000 B) | 1,000 | 328.628 | 0.328628 | 6.48x | 0.81 |

**Finding:** At larger inputs, scaling is approximately linear, not
quadratic/exponential. Effective exponents are below 1 for these measurements;
the small-input ratio is particularly affected by fixed call overhead.

## 2. Entity-pass comparison

Each individual pass was timed independently against the same 50 KB input. The
percent column is its share of the sum of those independent timings. The
sequential and combined rows are direct measurements, not sums of the
individual rows.

| Pass | Pattern | 100 iterations (ms) | Share of independent pass sum |
| --- | --- | ---: | ---: |
| 1 | `/&lt;/g` | 6.190 | 11.3% |
| 2 | `/&gt;/g` | 6.481 | 11.9% |
| 3 | `/&quot;/g` | 5.810 | 10.6% |
| 4 | `/&#39;/g` | 4.414 | 8.1% |
| 5 | `/&nbsp;/g` | 4.343 | 8.0% |
| 6 | `/&#(\d+);/g` | 22.467 | 41.2% |
| 7 | `/&amp;/g` | 4.858 | 8.9% |
| Independent pass sum | — | 54.562 | 100% |
| Seven sequential passes | — | 44.657 | — |
| Combined callback regex | — | 63.067 | — |

**Measured speedup (seven passes / combined): 0.71x.** The combined regex
produced the same output for the benchmark input, but was slower. These data
disprove the assumption that combining the passes is automatically a
performance win; no production decoder change is recommended from this result.

## 3. Minimal reproducer and timeout thresholds

The five fixture families were tested at 25, 50, 100, 200, 300, 400, 500 and
600 KB. Each entry below is the measured conversion time in milliseconds.
`PROFILE_TIMEOUT_MS` can override the script's 15,000 ms child-process limit.

| Fixture | 25 KB | 50 KB | 100 KB | 200 KB | 300 KB | 400 KB | 500 KB | 600 KB | First timeout |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 128 nested div/blockquote levels with repeated formatted/code content | 7.928 | 13.436 | 25.273 | 48.805 | 249.326 | 835.882 | 1,621.548 | 2,468.395 | Not observed |
| Repeated unclosed `<h2>` headings | 5.771 | 17.906 | 57.564 | 204.995 | 461.309 | 808.109 | 1,253.119 | 1,782.385 | Not observed |
| Repeated special links (`?q=a&amp;b=c`) | 20.143 | 35.398 | 212.399 | 687.579 | 1,450.833 | 2,247.090 | 3,738.979 | 5,205.336 | Not observed |
| Repeated unclosed `<strong>` formatting | 4.115 | 11.798 | 38.303 | 139.924 | 299.347 | 518.760 | 789.145 | 1,134.682 | Not observed |
| Unterminated title followed by body content | 0.747 | 0.836 | 0.979 | 1.264 | 1.597 | 1.973 | 2.281 | 2.512 | Not observed |

No fixture timed out, including the 25 KB and 50 KB probes; consequently, the
binary search had no success/timeout boundary to refine. The smallest failing
fixture and exact timeout threshold are **not established**. The unterminated
title fixture is also a limited stress case: the HTML rewriter/parser consumes
the malformed head/title region, so increasing its source size does not produce
comparable Markdown-body work.

Reproduction patterns used:

```html
<!-- nested case, repeated 128 times around the generated content -->
<div><blockquote> ... </blockquote></div>

<!-- repeated malformed heading / formatting cases -->
<h2>Unclosed heading ...
<strong>Unclosed formatting ...

<!-- repeated special-link case -->
<a href="/page?q=a&amp;b=c">Special link</a>
```

These are the tested fixtures, not minimal failing inputs; none failed within
the configured timeout.

## 4. `mdDec()` call pattern — 500 KB complex fixture

The fixture contains 128 nested div/blockquote wrappers and repeated paragraphs
with strong, emphasis and code elements. Stage timings and decoder instrumentation
were collected in one warmed run.

```text
Conversion duration:             1,595.752 ms
HTMLRewriter stage:                 23.910 ms
Markdown generation stage:       1,571.526 ms

mdDec() calls:                       6,117
Total time in mdDec():                4.922 ms
Average per call:                    0.000805 ms
Maximum single call:                 0.593 ms
mdDec() share of conversion:          0.31%

Call sizes:
  <100 characters:                   6,117
  100–1,000 characters:                  0
  >1,000 characters:                     0
```

The maximum single-call duration is an observed maximum from one run and may
include runtime pauses; it is not representative of the average. The call count
and size distribution are collected only when profiling is enabled.

## 5. Root-cause assessment

**Primary measured cost:** Markdown generation for the tested 500 KB complex
fixture, not `mdDec()`.

Evidence:

1. `mdDec()` was called 6,117 times in this fixture, rather than the previously
   suggested 48,381 times.
2. The decoder consumed 4.922 ms (0.31% of measured conversion time).
3. Markdown generation consumed 1,571.526 ms (98.48%); HTML rewriting consumed
   23.910 ms.
4. Isolated decoder scaling was approximately linear over the larger test
   sizes.
5. A combined entity regex was slower than the seven existing passes in the
   measured comparison.
6. No tested malformed/complex fixture reached the 15-second timeout through
   600 KB.

The internal Markdown-generation operation responsible for the long stage was
not isolated by these measurements. This phase therefore falsifies the specific
`mdDec()` bottleneck claim but does not fully explain the Markdown-stage cost.

## 6. Data-driven next steps

- **Do not combine entity passes based on this benchmark.** The tested combined
  callback regex was 1.41x slower.
- **Do not add a decode cache based on these measurements.** Decoder time is
  only 0.31% of this conversion, and cache hit rate/memory impact were not
  measured.
- **Profile the Markdown stage internally before optimizing it.** Add
  measurement around the major conversion passes and container/format handling,
  then repeat on the 500 KB nested and special-link fixtures. Preserve existing
  Markdown safety tests when evaluating candidate changes.
- **Treat timeout reports as unreproduced, not disproved universally.** The
  tested fixtures and local Node/WASM runtime may differ from the original
  workload or Cloudflare runtime; capture the exact source pattern and runtime
  when reproducing any production timeout.

## 7. Validation

- `npm test`: **119 tests passed**, 0 failed.
- Syntax checks passed for `markdown.js` and all three profiling scripts.
- `git diff --check` passed.
- Profiling did not change the decoder's seven replacement passes or the
  conversion output.
