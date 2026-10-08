import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/production-benchmark.yml", import.meta.url), "utf8");
const benchmarkJob = workflow.split("  benchmark:\n")[1].split("\n  commit-results:")[0];
const commitJob = workflow.split("  commit-results:\n")[1].split("\n  regression-issue:")[0];
const issueJob = workflow.split("  regression-issue:\n")[1];

test("production benchmark is manually runnable and scheduled daily at 19:00 UTC", () => {
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+iterations:/);
  assert.match(workflow, /checkpoint:/);
  assert.match(workflow, /cron: "0 19 \* \* \*"/);
  assert.doesNotMatch(workflow, /0 19 \* \* 2/);
  assert.match(workflow, /concurrency:\s+group: production-benchmark-/);
});

test("write permissions are isolated to result commits and issue handling", () => {
  assert.match(benchmarkJob, /permissions:\s+contents: read/);
  assert.equal((workflow.match(/contents: write/g) || []).length, 1);
  assert.equal((workflow.match(/issues: write/g) || []).length, 1);
  assert.match(commitJob, /permissions:\s+contents: write/);
  assert.match(commitJob, /\[skip ci\] Record production benchmark/);
  assert.match(commitJob, /git pull --rebase origin "\$GITHUB_REF_NAME"/);
  assert.match(commitJob, /failed to rebase benchmark results/);
  assert.match(commitJob, /failed to push benchmark results/);
  assert.match(issueJob, /permissions:\s+issues: write/);
  assert.match(issueJob, /gh issue (?:list|create|edit)/);
  assert.doesNotMatch(issueJob, /gh label create/);
});

test("scheduled results are artifact-backed and do not edit deployment workflow", () => {
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.equal((workflow.match(/actions\/download-artifact@87c55149d96e628cc2ef7e6fc2aab372015aec85 # v4\.1\.3/g) || []).length, 2);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /benchmark-results\/baseline\.json/);
  assert.match(workflow, /benchmark-results\/page-baseline\.json/);
});
