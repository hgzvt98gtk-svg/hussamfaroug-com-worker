import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeCloudflareCredentials } from "../scripts/cloudflare-credentials.mjs";

const script = fileURLToPath(new URL("../scripts/cloudflare-credentials.mjs", import.meta.url));
const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-Ab";
const accountId = "ee1ab37acbedc81c70af09ffc0c67501";

test("pasted secret formatting is normalized to a raw token and account ID", () => {
  for (const apiToken of [
    token, `${token}\n`, `  ${token}\r\n`, `"${token}"`, `'${token}'`,
    `Bearer ${token}`, `\uFEFF${token}`, `CLOUDFLARE_API_TOKEN=${token}`, `"Bearer ${token}"\n`
  ]) {
    assert.deepEqual(normalizeCloudflareCredentials({ apiToken, accountId: ` ${accountId.toUpperCase()}\n` }),
      { ok: true, apiToken: token, accountId }, JSON.stringify(apiToken));
  }
});

test("missing or malformed credentials fail with actionable errors that never echo the token", () => {
  const cases = [
    [{ apiToken: undefined, accountId }, /CLOUDFLARE_API_TOKEN secret is missing/],
    [{ apiToken: "  \n", accountId }, /CLOUDFLARE_API_TOKEN secret is missing/],
    [{ apiToken: "0123456789abcdef0123456789abcdef01234", accountId }, /Global API Key/],
    [{ apiToken: "v1.0-abc123", accountId }, /Origin CA key/],
    [{ apiToken: "abc def", accountId }, /invalid in an Authorization header/],
    [{ apiToken: "abc\ndef", accountId }, /invalid in an Authorization header/],
    [{ apiToken: token, accountId: "" }, /CLOUDFLARE_ACCOUNT_ID secret is missing/],
    [{ apiToken: token, accountId: "not-an-account" }, /32-character hexadecimal/]
  ];
  for (const [input, pattern] of cases) {
    const result = normalizeCloudflareCredentials(input);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), pattern);
    if (input.apiToken?.trim()) assert.ok(!result.errors.join("\n").includes(input.apiToken.trim()));
  }
});

test("CLI masks and exports normalized credentials, or fails without exporting", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudflare-credentials-"));
  try {
    const githubEnv = join(directory, "env");
    const ok = spawnSync(process.execPath, [script], {
      env: { GITHUB_ENV: githubEnv, CLOUDFLARE_API_TOKEN: `Bearer ${token}\n`, CLOUDFLARE_ACCOUNT_ID: accountId },
      encoding: "utf8"
    });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.ok(ok.stdout.startsWith(`::add-mask::${token}\n`));
    assert.equal(readFileSync(githubEnv, "utf8"),
      `CLOUDFLARE_API_TOKEN=${token}\nCLOUDFLARE_ACCOUNT_ID=${accountId}\n`);

    const failedEnv = join(directory, "failed-env");
    const failed = spawnSync(process.execPath, [script], {
      env: { GITHUB_ENV: failedEnv, CLOUDFLARE_API_TOKEN: "bad token", CLOUDFLARE_ACCOUNT_ID: accountId },
      encoding: "utf8"
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /::error title=Cloudflare credentials::/);
    assert.ok(!failed.stdout.includes("bad token"));
    assert.throws(() => readFileSync(failedEnv));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
