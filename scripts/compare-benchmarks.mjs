import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareBenchmarks, formatBenchmarkMarkdown } from "./benchmark-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!["--current", "--baseline", "--cloudflare-baseline", "--output", "--report", "--template", "--publish-report"].includes(flag) || !value) {
    throw new Error("Usage: node scripts/compare-benchmarks.mjs --current FILE --output FILE --report FILE [--baseline FILE] [--template FILE] [--publish-report FILE]");
  }
  options[flag.slice(2)] = value;
}
for (const required of ["current", "output", "report"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}

const currentPath = resolve(root, options.current);
const current = JSON.parse(await readFile(currentPath, "utf8"));
let baseline = null;
if (options.cloudflareBaseline) {
  const cloudflareBaseline = JSON.parse(await readFile(resolve(root, options.cloudflareBaseline), "utf8"));
  if (cloudflareBaseline.type !== "cloudflare-reported-worker-metrics") {
    throw new Error("--cloudflare-baseline must contain Cloudflare-reported Worker metrics");
  }
  current.cloudflareBaseline = cloudflareBaseline;
}
if (options.baseline) {
  try {
    const candidate = JSON.parse(await readFile(resolve(root, options.baseline), "utf8"));
    if (candidate.type === "production-real-page-benchmark" && candidate.fixtures?.length) baseline = candidate;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
current.baselineAvailable = Boolean(baseline);
const comparison = compareBenchmarks(current, baseline);
current.comparison = comparison;
if (comparison.baselineEstablished && options.baseline) {
  await mkdir(dirname(resolve(root, options.baseline)), { recursive: true });
  await writeFile(resolve(root, options.baseline), JSON.stringify(current, null, 2) + "\n");
}

const body = formatBenchmarkMarkdown(current, comparison);
const templatePath = resolve(root, options.template || "reports/benchmark-report-template.md");
const template = await readFile(templatePath, "utf8");
const report = template.replaceAll("{{BENCHMARK_REPORT}}", body).replaceAll("{{CHECKPOINT}}", current.label);
const comparisonPath = resolve(root, options.output);
await mkdir(dirname(comparisonPath), { recursive: true });
await writeFile(comparisonPath, JSON.stringify(comparison, null, 2) + "\n");
for (const outputPath of [options.report, ...(options.publishReport ? [options.publishReport] : [])]) {
  const path = resolve(root, outputPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, report);
}
await writeFile(currentPath, JSON.stringify(current, null, 2) + "\n");
console.log(report);
if (comparison.regressions.length) process.exitCode = 1;
