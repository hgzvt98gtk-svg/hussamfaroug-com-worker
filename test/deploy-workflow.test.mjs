import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const step = workflow.split("      - name: Re-enable observability\n")[1];

test("deployment verifies production discovery after publishing with Node 22", () => {
  const deploy = workflow.split("  deploy:\n")[1];
  assert.match(deploy, /uses: actions\/setup-node@v6\s+with:\s+node-version: "22"/);
  assert.match(deploy, /name: Verify production discovery metadata\s+run: node scripts\/verify-deployment\.mjs https:\/\/hussamfaroug\.com/);
  assert.ok(deploy.indexOf("command: deploy") < deploy.indexOf("name: Verify production discovery metadata"));
  assert.doesNotMatch(deploy, /continue-on-error:/);
});

test("observability PATCH expands secret-backed authorization and propagates HTTP failures", () => {
  assert.ok(step, "observability step exists");
  assert.match(step, /CF_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.match(step, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  const script = step.match(/        run: \|\n([\s\S]*?)        env:/)?.[1];
  assert.ok(script, "observability shell command exists");
  const env = { CF_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-token-$literal" };
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c",
    `curl() { printf '%s\\0' "$@"; }\n${script}`
  ], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.split("\0").slice(0, -1);
  assert.ok(args.includes("-fsS"), "curl must fail on HTTP errors");
  assert.equal(args[args.indexOf("-X") + 1], "PATCH");
  assert.ok(args.includes("https://api.cloudflare.com/client/v4/accounts/test-account/workers/scripts/hussamfaroug-com/script-settings"));
  const headers = args.filter((value, index) => args[index - 1] === "-H");
  assert.ok(headers.includes("Authorization:" + " Bearer " + env.CLOUDFLARE_API_TOKEN));
  assert.ok(headers.includes("Content-Type: application/json"));
  const body = JSON.parse(args[args.indexOf("-d") + 1]);
  assert.equal(body.observability.enabled, true);
  assert.equal(body.observability.logs.enabled, true);

  const failure = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c",
    `curl() { return 22; }\n${script}`
  ], { env, encoding: "utf8" });
  assert.equal(failure.status, 22, "curl HTTP failures must fail the step");

  for (const token of [undefined, ""]) {
    const missingTokenEnv = { CF_ACCOUNT_ID: env.CF_ACCOUNT_ID };
    if (token !== undefined) missingTokenEnv.CLOUDFLARE_API_TOKEN = token;
    const missingToken = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c",
      `curl() { printf 'curl invoked'; }\n${script}`
    ], { env: missingTokenEnv, encoding: "utf8" });
    assert.notEqual(missingToken.status, 0, "missing or empty tokens must fail the step");
    assert.equal(missingToken.stdout, "", "missing tokens must not reach curl");
    assert.match(missingToken.stderr, /CLOUDFLARE_API_TOKEN is required/);
  }
});
