import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Wrangler sends the API token in the Authorization request header. Cloudflare
// rejects anything that is not RFC 7235 token68 syntax with code 6111
// ("Invalid format for Authorization header"), which is what a pasted trailing
// newline, quotes, a duplicated "Bearer " prefix, or embedded spaces produce.
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;
const GLOBAL_API_KEY = /^[0-9a-f]{37}$/i;
const ORIGIN_CA_KEY = /^v1\.0-/i;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

function unwrap(value, name) {
  let result = String(value ?? "").replace(/^\uFEFF/, "").trim();
  result = result.replace(new RegExp(`^(?:export\\s+)?${name}\\s*[=:]\\s*`), "").trim();
  const quote = result[0];
  if ((quote === '"' || quote === "'") && result.length > 1 && result.at(-1) === quote) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

export function normalizeCloudflareCredentials({ apiToken, accountId } = {}) {
  const errors = [];
  const token = unwrap(apiToken, "CLOUDFLARE_API_TOKEN").replace(/^Bearer\s+/i, "").trim();
  const account = unwrap(accountId, "CLOUDFLARE_ACCOUNT_ID").toLowerCase();

  if (!token) {
    errors.push("CLOUDFLARE_API_TOKEN secret is missing or empty. Add a Cloudflare API token (Edit Cloudflare Workers template) as a repository secret.");
  } else if (GLOBAL_API_KEY.test(token)) {
    errors.push("CLOUDFLARE_API_TOKEN looks like a Global API Key. Wrangler needs a scoped API token (Edit Cloudflare Workers template), not the Global API Key.");
  } else if (ORIGIN_CA_KEY.test(token)) {
    errors.push("CLOUDFLARE_API_TOKEN looks like an Origin CA key. Wrangler needs a scoped API token (Edit Cloudflare Workers template).");
  } else if (!TOKEN68.test(token)) {
    errors.push("CLOUDFLARE_API_TOKEN contains characters that are invalid in an Authorization header (for example spaces or line breaks inside the value). Paste only the raw token value.");
  }

  if (!account) {
    errors.push("CLOUDFLARE_ACCOUNT_ID secret is missing or empty.");
  } else if (!ACCOUNT_ID.test(account)) {
    errors.push("CLOUDFLARE_ACCOUNT_ID must be the 32-character hexadecimal account ID from the Cloudflare dashboard.");
  }

  return errors.length ? { ok: false, errors } : { ok: true, apiToken: token, accountId: account };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = normalizeCloudflareCredentials({
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID
  });
  if (!result.ok) {
    for (const error of result.errors) console.log(`::error title=Cloudflare credentials::${error}`);
    process.exitCode = 1;
  } else {
    console.log(`::add-mask::${result.apiToken}`);
    console.log(`::add-mask::${result.accountId}`);
    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV,
        `CLOUDFLARE_API_TOKEN=${result.apiToken}\nCLOUDFLARE_ACCOUNT_ID=${result.accountId}\n`);
    }
    console.log("Cloudflare credentials are present and correctly formatted.");
  }
}
