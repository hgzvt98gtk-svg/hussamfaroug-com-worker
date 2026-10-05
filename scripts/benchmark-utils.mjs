export function statistics(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    min: sorted[0],
    max: sorted.at(-1),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p99: percentile(0.99)
  };
}

function splitOutsideQuotes(value, delimiter) {
  const parts = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

export function parseServerTiming(header) {
  const timings = {};
  if (!header) return timings;
  for (const metric of splitOutsideQuotes(header, ",")) {
    const [name, ...parameters] = splitOutsideQuotes(metric, ";");
    const stage = name.trim();
    const duration = parameters.map(parameter => parameter.trim().match(/^dur\s*=\s*"?([0-9]+(?:\.[0-9]+)?)"?$/i)?.[1])
      .find(value => value !== undefined);
    if (!stage || duration === undefined) continue;
    const milliseconds = Number(duration);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      timings[stage] = (timings[stage] || 0) + milliseconds;
    }
  }
  return timings;
}

export function selectCheckpointLabel(now = new Date(), deployedAt = "2026-10-04T18:31:55Z") {
  const elapsed = new Date(now).getTime() - new Date(deployedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("Checkpoint time must be after the deployment time");
  const elapsedDays = Math.floor(elapsed / 86_400_000);
  if (elapsedDays === 1) return "24h";
  if (elapsedDays === 2) return "48h";
  return elapsedDays === 0 ? "baseline" : "ongoing";
}

function compatibleFixture(current, previous) {
  return current.path === previous.path &&
    current.sourceHtmlBytes === previous.sourceHtmlBytes &&
    current.sourceSha256 === previous.sourceSha256;
}

export function compareBenchmarks(current, baseline = null) {
  const regressions = [];
  const fixtureComparisons = [];
  const totalRequests = current.fixtures.reduce((sum, fixture) => sum + fixture.iterations, 0);
  const errors = current.fixtures.reduce((sum, fixture) => sum + fixture.errors, 0);

  for (const fixture of current.fixtures) {
    if (fixture.errors > 0) regressions.push(`${fixture.name}: ${fixture.errors} request error(s), error rate ${(fixture.errors / fixture.iterations * 100).toFixed(2)}%`);
    for (const sample of fixture.samples) {
      if (sample.status !== 200 || sample.error) {
        regressions.push(`${fixture.name}: ${sample.error ? "request/body error" : `HTTP ${sample.status}`} on iteration ${sample.iteration}`);
      }
    }
    if (fixture.timings.total?.p99 > 500 || fixture.timings.total?.max > 500) {
      regressions.push(`${fixture.name}: total latency exceeded 500 ms (p99 ${fixture.timings.total.p99.toFixed(2)} ms, max ${fixture.timings.total.max.toFixed(2)} ms)`);
    }
    const conversion = fixture.timings.serverTiming?.conversion;
    if (conversion && (conversion.p99 > 500 || conversion.max > 500)) {
      regressions.push(`${fixture.name}: conversion timing exceeded 500 ms (p99 ${conversion.p99.toFixed(2)} ms, max ${conversion.max.toFixed(2)} ms)`);
    }

    const previous = baseline?.fixtures?.find(entry => entry.name === fixture.name);
    const compatible = previous && compatibleFixture(fixture, previous);
    const comparison = { name: fixture.name, path: fixture.path, compatible: Boolean(compatible), meanDeltaPercent: null };
    if (compatible) {
      const deltas = {};
      for (const metric of ["total", "conversion"]) {
        const currentStats = metric === "total" ? fixture.timings.total : fixture.timings.serverTiming?.conversion;
        const previousStats = metric === "total" ? previous.timings.total : previous.timings.serverTiming?.conversion;
        if (currentStats?.mean !== undefined && previousStats?.mean > 0) {
          const delta = (currentStats.mean / previousStats.mean - 1) * 100;
          deltas[metric] = delta;
          if (delta > 20) regressions.push(`${fixture.name}: ${metric} mean is ${delta.toFixed(2)}% worse than the fixture baseline (investigation signal)`);
        }
      }
      comparison.meanDeltaPercent = deltas;
    }
    fixtureComparisons.push(comparison);
  }

  if (totalRequests > 0 && errors / totalRequests > 0) regressions.push(`Overall request error rate is ${(errors / totalRequests * 100).toFixed(2)}%`);
  return {
    passed: regressions.length === 0,
    regressions: [...new Set(regressions)],
    fixtureComparisons,
    baselineEstablished: !baseline?.fixtures?.length && current.success && regressions.length === 0
  };
}

export function formatBenchmarkMarkdown(current, comparison) {
  const rows = current.fixtures.map(fixture => {
    const timing = fixture.timings.total;
    const conversion = fixture.timings.serverTiming?.conversion;
    const stages = conversion ? `${conversion.p50.toFixed(2)} / ${conversion.p99.toFixed(2)} / ${conversion.max.toFixed(2)} ms` : "Not exposed by production";
    const deltas = comparison.fixtureComparisons.find(item => item.name === fixture.name)?.meanDeltaPercent;
    const delta = deltas
      ? `total ${deltas.total === undefined ? "n/a" : `${deltas.total.toFixed(1)}%`}; conversion ${deltas.conversion === undefined ? "n/a" : `${deltas.conversion.toFixed(1)}%`}`
      : "n/a";
    return `| ${fixture.name} | \`${fixture.path}\` (${fixture.sourceHtmlBytes.toLocaleString()} B source HTML) | ${timing.p50.toFixed(2)} / ${timing.p99.toFixed(2)} / ${timing.max.toFixed(2)} ms | ${stages} | ${delta} | ${fixture.timings.responseBytes?.mean?.toFixed(0) ?? "n/a"} B | ${fixture.statusCodes.join(", ") || "none"} |`;
  });
  const baseline = comparison.baselineEstablished
    ? "This successful run establishes the first real-page baseline; it was not compared with itself."
    : current.baselineAvailable
      ? "Mean comparisons apply only when the source page path, byte size, and SHA-256 match the real-page baseline."
      : "No real-page baseline exists yet; absolute latency and response status checks still apply.";
  const details = comparison.regressions.length
    ? `\n## Regression signals\n\n${comparison.regressions.map(item => `- ${item}`).join("\n")}\n`
    : "\nNo regression conditions were detected in the measured requests.\n";
  const cloudflareRows = current.cloudflareBaseline?.measurements?.map(item =>
    `| ${item.date} | ${item.requests} | ${item.errors} | ${item.cpuMs.p50} / ${item.cpuMs.p99} | ${item.durationMs.p50} / ${item.durationMs.p99} |`) || [];
  const cloudflareContext = cloudflareRows.length
    ? `\n## Cloudflare-reported baseline (context only)\n\nThese Worker metrics are not fixture measurements and are not directly comparable to these end-to-end request timings.\n\n| Date | Requests | Errors | CPU p50 / p99 (ms) | Duration p50 / p99 (ms) |\n| --- | ---: | ---: | ---: | ---: |\n${cloudflareRows.join("\n")}\n`
    : "";
  return `# Production benchmark — ${current.label}

- Measured: ${current.timestamp}
- Target: \`${current.target}\`
- Iterations per page: ${current.iterations}; warmups discarded: ${current.warmups}
- Method: read-only GET requests to real production HTML pages with \`Accept: text/markdown\`.
- Limitation: the configured origin cannot accept injected fixture HTML through the public read-only proxy. The pages below are real origin pages selected closest to 10 KB, 100 KB, and 500 KB source sizes; they are not generated fixtures.
- Conversion timing: production currently does not emit a \`Server-Timing\` header. The script parses it when present; Cloudflare's sampled internal metrics are not request-level fixture measurements and are not substituted here.
- Thresholds: fail for any non-200/request error, total or conversion p99/max above 500 ms, or a compatible fixture mean more than 20% worse than its baseline. A >20% mean change is an investigation signal, not a release verdict from one small sample.
- Baseline: ${baseline}
- Local reference: the 500 KB local Node/WASM profiling fixture generated Markdown in approximately 76–89 ms; that is not a production latency baseline.

| Target | Real page / source size | Total latency p50 / p99 / max | Conversion p50 / p99 / max | Mean delta vs exact-page baseline | Markdown response mean | Statuses |
| --- | --- | ---: | ---: | --- | ---: | ---: |
${rows.join("\n")}
${details}
${cloudflareContext}
Local Node/WASM benchmark values are not directly comparable to production native HTMLRewriter timings. Fixture benchmarks complement, and do not replace, Cloudflare observability.
`;
}
