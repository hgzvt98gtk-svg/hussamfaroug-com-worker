# Phase 2: Markdown generation profiling

## Findings and decision

The measured bottleneck is **protected-text restoration**, not an individual
regex: it accounts for 97.94% of Markdown time in the complex fixture and 93.26%
in the container fixture. The old `join()` repeatedly concatenated the accumulated
output and inspected it with `endsWith()`. On this V8 runtime, that combination
repeatedly flattens growing strings, producing approximately quadratic copying.

The targeted change collects fragments and joins them once. Boundary checks use
the previous **nonempty** fragment, preserving the space inserted between adjacent
backtick delimiters even when empty fragments intervene. The shared helper also
serves code, anchors, and container text. No regex, entity-decoding order, URL
validation, recursion, or HTML filtering was changed.

Markdown generation improved **46.73×** (complex) and **13.24×** (containers).
Both 500,000-byte fixtures now generate Markdown in about 76–89 ms on average.
**The end-to-end <500 ms target is not consistently met in this environment**:
the unchanged WASM HTMLRewriter now dominates. Do not interpret the Markdown-only
speedup as a production Worker latency guarantee.

## Methodology and reproduction

Measured on 2026-10-04, Node v22.23.3, Linux x64, using the existing
`html-rewriter-wasm@0.4.1` streaming adapter. Each fixture has exactly 500,000
UTF-8 bytes (decimal KB), three uninstrumented warmups, and ten sequential timed
conversions. Timings below are arithmetic means in milliseconds; the profiler
also prints minimum and maximum values and can save JSON with source, fixture,
and output SHA-256 fingerprints.

- `complex`: repeated headings, paragraphs, bold, emphasis, validated links,
  unordered lists, and preformatted code; the same content unit as the existing
  benchmark's complex fixture.
- `containers`: repeated headings and blockquotes containing formatting and
  links, ordered lists with adjacent code spans, and entity-bearing prose.
- Every replacement pass includes its callback work, including any nested
  `containerText()` work. Nested work is not double-counted as a separate pass.
  `restoreProtected` includes marker splitting, lookup, and joining, not just
  the join helper.
- Whole `markdown` timing includes all passes and instrumentation overhead;
  `total` includes HTMLRewriter and title preparation, but no origin network.
  Small per-pass changes should not be treated as significant.
- The original Phase 1.1 report/fixtures are absent from this checkout. These are
  new reproducible measurements, not a reproduction of its stated 1,482.7 ms.

Use these commands from the repository root:

```sh
npm ci
node scripts/profile-markdown-generation.mjs --output /tmp/markdown-generation-baseline.json
# After applying the join optimization:
node scripts/profile-markdown-generation.mjs --baseline /tmp/markdown-generation-baseline.json --output /tmp/markdown-generation-optimized.json
npm test
```

For a fresh comparison, first run the instrumented pre-optimization revision
(`40c2270`), then the optimized revision in a separate worktree. Do not generate
the baseline with the already optimized implementation. `--iterations N` accepts
integers of at least three (default ten). Baseline comparison rejects mismatched
fixture hashes or output hashes. Every measured conversion is also checked
against its uninstrumented warmup output.

Optional API:

```js
await convertMd(html, url, onTiming, (pass, milliseconds) => {
  // Collect inclusive pass timings.
});
```

The existing third argument still emits only `rewriter` and `markdown`.
The fourth argument can be supplied independently; when omitted, pass timing
does not read the clock. Normal Worker metrics remain unchanged.

## Detailed pass breakdown

| Operation | Complex baseline | Complex optimized | Containers baseline | Containers optimized |
|---|---:|---:|---:|---:|
| Extract main/body | 0.325 | 0.310 | 0.334 | 0.334 |
| Heading | 6.319 | 7.812 | 18.360 | 22.505 |
| Pre | 5.768 | 6.526 | 0.121 | 0.120 |
| Code | 0.153 | 0.140 | 8.063 | 10.601 |
| Blockquote | 0.101 | 0.092 | 19.142 | 21.094 |
| Anchor | 5.213 | 6.014 | 0.270 | 0.313 |
| List | 11.404 | 8.568 | 18.585 | 19.832 |
| Format | 19.001 | 15.416 | 1.864 | 1.699 |
| Strip tags | 2.437 | 2.408 | 1.548 | 1.132 |
| Decode/escape prose | 18.053 | 19.149 | 9.048 | 7.543 |
| Normalize whitespace | 4.387 | 3.600 | 1.464 | 1.492 |
| **Restore protected text** | **3,491.981** | **5.906** | **1,095.367** | **1.646** |
| Escape output angles | 0.302 | 0.292 | 0.367 | 0.359 |
| **Markdown total** | **3,565.503** | **76.292** | **1,174.570** | **88.711** |
| HTMLRewriter | 656.741 | 712.175 | 913.831 | 1,231.718 |
| **Conversion total** | **4,222.378** | **788.543** | **2,088.496** | **1,320.470** |

The top three baseline Markdown operations are:

1. Complex: restoration (3,491.981 ms), format (19.001 ms),
   decode/escape prose (18.053 ms). Among regex replacement passes specifically,
   format, list (11.404 ms), and heading (6.319 ms) are slowest.
2. Containers: restoration (1,095.367 ms), blockquote (19.142 ms),
   list (18.585 ms); heading (18.360 ms) is close behind.

Restoration improved 591.29× and 665.43×, respectively. End-to-end mean speedups
are 5.35× and 1.58×. Rewriter variance and runtime scheduling limit direct
end-to-end comparisons; the restoration improvement is much larger than that
noise.

### Ranges (minimum–maximum milliseconds, ten samples)

| Stage | Complex baseline | Complex optimized | Containers baseline | Containers optimized |
|---|---:|---:|---:|---:|
| Restoration | 3,444.201–3,572.756 | 5.016–8.293 | 1,087.187–1,099.160 | 1.225–2.772 |
| Markdown | 3,514.652–3,651.204 | 68.450–88.024 | 1,162.656–1,186.250 | 69.911–102.339 |
| HTMLRewriter | 647.724–671.581 | 358.041–904.793 | 903.180–940.510 | 973.408–1,353.411 |
| Total | 4,167.714–4,306.305 | 445.469–975.957 | 2,073.598–2,115.914 | 1,072.264–1,436.692 |

No multi-minute timeout occurred. One complex conversion completed in 445 ms,
but neither its mean nor its maximum meets <500 ms, and no container conversion
meets that end-to-end threshold. The data does not establish a regression in
native Workers' HTMLRewriter; it measures the local WASM adapter.

## Compatibility and validation

- Both fixture output SHA-256 values match before and after optimization:
  - Complex: `3496817f33b6bc7a6f2fef14044c4c6aa389ec95f84196d5604909f6e1801a04`
  - Containers: `0c0482b6d8c1619723d04a13884c1691a21a5dc7cc8d326271c386619f463b1d`
- Baseline source SHA-256:
  `a725631794556048c8440cfd5b38f7c8ac3271315924a2e7c0cd210a8d6256a2`.
  Optimized source:
  `2fa20b865b7bf97f490d329717ff3bbd3a01fbf3c07f7e88de2c20a79b2a270f`.
- Focused tests cover pass names/timing values, unchanged stage callbacks,
  standalone pass instrumentation, empty/nonempty fragment boundaries, rendered
  adjacent code spans in containers, and exact output for 8,000 protected code
  fragments.
- `npm test`: **122 passing, zero failures** (the existing 119 plus three new
  tests, counting nested subtests).
- Existing unsafe-URL, entity-decoding, code-delimiter, linked-image, and
  Markdown-injection regressions remain covered. No dependencies were added.

## Recommendations

1. Keep the measured array-join optimization; it removes the dominant Markdown
   bottleneck without changing conversion semantics.
2. Measure the same fixtures under native Cloudflare HTMLRewriter before claiming
   the end-to-end <500 ms target. If that target also fails there, profile the
   HTMLRewriter stage separately, particularly attribute handling; do not weaken
   destination sanitization to improve a local benchmark.
3. If Markdown-only latency needs further reduction, profile nested formatting
   callbacks and prose marker splitting next. Anchor/list regex rewrites,
   memoization, entity-regex merging, or streaming are not justified by these
   results: their potential savings are small compared with the removed cost.
