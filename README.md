# hussamfaroug-com Worker CI/CD

## What this does

This repo deploys the `hussamfaroug-com` Cloudflare Worker via GitHub Actions on every push to `main`.

## Setup

### 1. Create a Cloudflare API token

1. Go to [Account API tokens](https://dash.cloudflare.com/?to=/:account/api-tokens)
2. Click **Create Token**
3. Select **Edit Cloudflare Workers** template
4. Scope it to your account only
5. Copy the token value; never commit it

### 2. Add GitHub repository secrets

Go to your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `ee1ab37acbedc81c70af09ffc0c67501` |
| `CLOUDFLARE_API_TOKEN` | (the token you just created) |

### 3. Push to main

Any push to `main` now automatically deploys the Worker via `wrangler deploy`.

You can also trigger a deploy manually from the **Actions** tab → **Run workflow**.

## Files

- `.github/workflows/deploy.yml` — the CI/CD workflow
- `wrangler.toml` — Wrangler configuration (Worker name, entry point, KV binding, and custom-domain route; no cron trigger)
- `hussamfaroug-com-worker.js` — the Worker code
- `metadata.js`, `bot-auth.js`, `markdown.js`, and `response.js` — focused Worker modules
- `discovery.js` — shared public resource links and browser-tool definition
- `proxy.js` — Accept negotiation, bounded HTML reads, and origin request lifecycle (including retry)
- `rate-limit.js` — per-client request rate limiting
- `metrics.js` — per-isolate request, error, retry, and conversion metrics
- `scripts/verify-deployment.mjs` — post-deployment endpoint smoke checks

## Tests

Run `npm ci` followed by `npm test` (or `node --test`). Markdown filtering uses
Cloudflare's native `HTMLRewriter`; Node tests use its WebAssembly parser implementation.

## Branch protection (fixes CASB findings)

After your first successful workflow run, enable branch protection in GitHub:

1. Repo → **Settings → Branches → Add branch protection rule**
2. Branch name pattern: `main`
3. Enable:
   - Require pull request before merging
   - Dismiss stale pull request approvals when new commits are pushed
   - Do not allow bypassing the above settings
   - Require status checks to pass before merging (select the `test` job)
4. Click **Create**

This clears all 4 CASB findings from your Cloudflare Security Center.

The origin used for proxied requests is configured as `ORIGIN` in `wrangler.toml`.
Routes are top-level Wrangler settings, not entries in `[vars]`.

## Public access and proxy policy

The Worker accepts GET, HEAD, and OPTIONS only. Write methods return 405, including
on discovery routes. It is a public, read-only proxy: incoming cookies,
Authorization, proxy credentials, and forwarding-host headers are not sent to
the configured origin. Paths cannot change that origin. Origin URLs must use
HTTP(S), contain no credentials, and differ from the public Worker origin.
HEAD requests that prefer Markdown return the Markdown headers without reading or
converting the origin body, so they omit `x-markdown-tokens`.

Caller-supplied Forwarded, X-Forwarded-Host/Proto/For, X-Real-IP, X-Client-IP,
Client-IP, X-Cluster-Client-IP, True-Client-IP, CF-Connecting-IP/IPv6,
CF-Pseudo-IPv4, and Fastly-Client-IP are deleted from the copied origin headers,
along with Connection-nominated fields. No replacement client identity is
invented. This list is not a trust guarantee for arbitrary custom headers.
Cloudflare can add or rewrite platform headers on subrequests after this filter;
mocked fetch assertions verify only what the Worker passes to fetch. Validate the
actual deployed origin headers and routing before trusting any client-IP field
for authorization or rate limiting.

Origin fetch failures (network errors and timeouts, not HTTP error statuses)
are retried once after 100 ms; client cancellation stops retries. Exhausted
retries return a generic non-cacheable 502 without logging origin errors or URLs.

GET and HEAD requests are limited to 100 per minute per `CF-Connecting-IP`
value (requests without it share an `unknown` bucket). Excess requests receive
a non-cacheable 429 with `Retry-After: 60`. The limiter is in-memory and
best-effort: state is per isolate, not global, and holds at most 10,000 clients.
Use Cloudflare WAF rate limiting rules for globally enforced limits.

HTML responses receive a Content-Security-Policy. When the origin sends one,
the Worker nonce and Turnstile sources are added to `script-src-elem`, else
`script-src`, else a new `script-src` inheriting `default-src`; existing
sources are never removed. Missing or empty origin policies get a strict default.

Origin requests are unconditional (no Range or conditional validator headers),
request HTML when available, and have a 10-second timeout covering headers and
body transfer. Client cancellation propagates to the origin. Non-HTML responses
remain streamed. HTML responses stream through Cloudflare's HTMLRewriter.
Only the exact `text/html` media type (trimmed, case-insensitive, before any
parameters) is converted or rewritten. Missing/misleading Content-Type values
and null upstream bodies remain passthrough.
Transformed responses discard upstream byte lengths, encodings, and validators.
The `enable_request_signal` compatibility flag enables incoming client-disconnect
signals despite the older compatibility date.

Markdown is selected when explicitly requested with a positive Accept quality
at least as high as HTML. Wildcard-only requests retain HTML. Conversion reads
at most 1 MiB of decoded upstream bytes; oversized or failed reads return a
non-cacheable 502. It preserves upstream status, cache directives, and Vary,
adding Accept. Markdown defaults to `no-store` when upstream Cache-Control is absent.

All proxied representations (including HEAD and null-body responses) use
`private, no-store` for incoming Authorization, Cookie, X-API-Key, X-Auth-Token,
X-Access-Token, Bearer, or X-Custom-Auth headers, or upstream Set-Cookie.
Detection uses the original request even when a header is stripped before
forwarding. Copied CDN-Cache-Control, Cloudflare-CDN-Cache-Control, and
Surrogate-Control are also overridden when present. Anonymous upstream policies
and static public metadata remain unchanged. This enumerated list does not detect
arbitrary custom identity inputs; revisit it before introducing new authenticated
origin behavior. This is conditional cache hardening, not a demonstrated exploit
against the current static origin.

Markdown link and image destinations resolve against the origin page URL and
allow only HTTP/HTTPS (not mailto/tel or embedded data). Invalid links become
escaped label text; invalid images become escaped alt text. Attribute decoding
supports decimal/hex numeric references and the named amp, lt, gt, quot, apos,
nbsp, colon, Tab, and NewLine entities. Unresolved destination entity references
are rejected conservatively rather than passed through. Controls are rejected;
parentheses are percent-encoded and brackets Markdown-escaped (including IPv6
hosts). Structural query ampersands remain intact. Labels are Markdown-escaped,
and generated links are restored after the prose entity-decoding pass so it
cannot resurrect rejected schemes or link syntax.

Phase 1 discovery publishes `/.well-known/openid-configuration`,
`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`,
and `/.well-known/mcp/server-card.json`. These JSON resources are CORS-enabled and
publicly cacheable for one hour, and linked from the shared catalogs and
`/.well-known/agent-skills/` (also available as `agent-skills/index.json`).
The MCP card describes the existing browser-only `get_site_info` WebMCP tool,
not an HTTP MCP transport. `/auth.md` documents discovery, manual registration
contact, and HTTP message signature verification.

### OAuth/OIDC discovery scope

The Worker publishes OAuth 2.0 and OpenID Connect discovery endpoints and
metadata only. **Important:** it does NOT implement:

- Token issuance
- Authorization code flow
- OpenID Connect provider
- Automated agent registration

The advertised authorize, token, and JWKS endpoints do not function. To add real
OAuth authentication, configure an external OAuth provider and update the
discovery endpoints to point to that provider's actual endpoints. The
authorization server metadata includes an `agent_auth` block whose `register_uri`
points to `/auth.md#agent-registration`, a GET-only manual registration guide,
not a registration API, and whose `skill` points to `/auth.md`.
`identity_types_supported` is `["anonymous"]` (agents read public content
without registering) and `credential_types_supported` (top level and under
`anonymous`) is `["none"]` because no credential is issued. Protected resource
metadata lists `bearer_methods_supported: ["header"]` for checker compatibility;
the site does not require or validate bearer tokens. Claim and revocation URLs
are omitted because those services do not exist.
`scripts/auth-metadata.mjs` holds the shared PRM -> authorization server ->
`/auth.md` chain invariants used by the tests and the deployment verifier. `/auth.md` opens with a disclaimer and documents manual registration by
contacting the administrator.
Public content still needs no credentials. A2A, HTTP MCP, and legacy credential
service paths remain 404.

## Observability and deployment verification

The Worker emits structured JSON metrics to `console.log` (visible in Cloudflare
Workers Logs when observability logging is enabled). Each isolate tracks total
requests, HTML/Markdown requests, rate-limit rejections, upstream 5xx and origin
configuration errors, conversion and retry errors, successful retries, and
conversion count/minimum/average/maximum duration. Conversion averages cover
conversions only, not all requests.

Counters are in-memory and per isolate: they reset when an isolate restarts and
are not globally aggregated. A metrics record is logged after each 1,000
requests or five minutes, whichever comes first, when a request arrives. There
is no background timer or public metrics endpoint, so quiet isolates do not
emit time-based logs while idle. Logs contain aggregate counters only, not URLs,
client addresses, or origin error details.

Run the non-destructive deployment smoke checks after deployment:

```sh
node scripts/verify-deployment.mjs
# Or provide a deployment origin:
node scripts/verify-deployment.mjs https://hussamfaroug.com
```

The script checks the OAuth discovery document, OAuth protected resource
metadata, authorization server metadata, MCP server card, `/auth.md`, the full
Auth.md discovery chain between them, and a healthy root request without
following redirects; it prints JSON and exits nonzero if checks fail. The
deploy workflow runs it against production after every `main` deployment, so a
stale or malformed live deployment fails the workflow instead of passing
silently. Only `hussamfaroug.com/*` is routed to the Worker (`wrangler.toml`);
other hostnames such as `www` or the Pages origin do not serve this metadata.
The root check confirms the Worker responds through its retry and rate-limit
middleware, but does not force a transient origin failure or send a burst of
requests to trigger the rate limit. It cannot observe metrics logging from the
public response; confirm metrics records in Workers Logs separately.

No production conversion-latency baseline has been measured. Use the logged
per-isolate conversion duration aggregates to establish a representative
baseline under normal traffic before setting latency targets. The local
Markdown benchmark above measures parser work on Node, not deployed Worker CPU
or end-to-end production latency. Monitor error/retry/rate-limit counts
alongside request volume, compare across deployments, and alert on sustained
changes rather than isolated per-isolate samples.

## Signing key provisioning and rotation

Before using `/.well-known/http-message-signatures-directory`, provision an
Ed25519 private JWK in the `SITE_CONFIG` KV namespace under
`BOT_AUTH_PRIVKEY_JWK`, using a trusted administrative environment and Cloudflare's
KV tooling or dashboard. The JWK must contain matching `kty: OKP`, `crv: Ed25519`,
public `x`, and private `d` components. Restrict administrative access to that
namespace; never place key material in this repository or logs.

The Worker derives its public directory from that key, validates the key pair,
and never generates or writes keys during requests. Missing or invalid keys
return 503. `BOT_AUTH_PUBKEY_JWK` is no longer used.

To rotate, replace the provisioned private JWK centrally. Each isolate reloads
after its 60-second cache expires; concurrent requests share the reload. KV
propagation adds additional delay. Directory responses may remain cached for
240 seconds, and signatures expire after 300 seconds. Coordinate verifier
refreshes and allow for those overlap periods; this is not instant revocation.

## Validation and deployment

Pull requests and main pushes run `npm ci` and `npm test` on Node 22.
Deployment on main waits for the test job. No standalone lint/build scripts
are defined. Large-document coverage exercises 5,000 paragraphs. The converter
retains its pass order and parser filtering; fixed tag regexes are shared and
tag stripping collects contiguous text slices instead of per-character strings.

Before release, validate Wrangler configuration and test staging routing,
double-slash destination confinement, HEAD, cache headers, origin timeouts,
and centrally provisioned signing keys. Local tests do not establish deployed
edge normalization, KV propagation, or shared-cache behavior.

### Historical Markdown benchmark (Phase 2.2)

The following results were recorded on the old task branch, not newly measured
or deployed gains. Measured on Node v22.23.3, Linux 6.17.0-1022-azure x86-64, Intel Xeon Platinum
8573C, using the locked html-rewriter-wasm parser. CPU profiling first exposed a
Node ReadableStream queue artifact in the test adapter; the benchmark below
buffers parser output to exclude that artifact. The buffered baseline profile
showed conversion/GC costs, motivating fixed-regex hoisting and text slicing.
No passes were fused, and UTF-8 token accounting, read limits, and timeouts were
not changed.

Paired run: five warmups per version, nine alternating samples, 25 conversions
per small sample and two per near-limit sample. Each output was compared exactly.

| Input UTF-8 bytes | Before median (range), ms | After median (range), ms | Output bytes |
|---|---|---|---|
| 5,101 | 1.302 (1.192–2.141) | 1.337 (1.199–1.874) | 4,604 |
| 1,048,565 | 230.551 (223.380–245.197) | 191.556 (184.392–197.035) | 949,628 |

Identical before/after SHA-256:
small `3fb978d6526a90c4764fb42947a64a95d06b52181faa3039f052ae69808aa9d1`;
near-limit `0e5f0d85600341a081f19741f67a849c69265dfbd32502884386f6ded11e0817`.
These are local corpus-specific measurements, not promised edge CPU savings.
There is no demonstrated small-document improvement; its timing ranges overlap.
The final paired corpus excludes multi-parameter queries and linked images,
whose intentional correctness fixes differ from the Phase 3.3 baseline and
are covered by separate regressions. Further pass fusion is deferred.
To reproduce from this repository after `npm ci`
(baseline is the Phase 3.3 commit; fetch its history if needed):

```sh
BASE_REF=431c0b1ac17f6b82a7f0ed8042c32ed906a4c0ae node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HTMLRewriter as Parser } from 'html-rewriter-wasm';
import { convertMd as after } from './markdown.js';
console.log({ runtime: process.version,
  baseline: execFileSync('git', ['rev-parse', process.env.BASE_REF], { encoding: 'utf8' }).trim(),
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  candidateSourceSha256: createHash('sha256').update(readFileSync('markdown.js')).digest('hex'),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() || 'clean' });
const source = execFileSync('git', ['show', `${process.env.BASE_REF}:markdown.js`], { encoding: 'utf8' });
const { convertMd: before } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
globalThis.HTMLRewriter = class {
  handlers = [];
  on(...args) { this.handlers.push(['on', ...args]); return this; }
  onDocument(...args) { this.handlers.push(['onDocument', ...args]); return this; }
  transform(response) {
    const handlers = this.handlers;
    return { async text() {
      const chunks = [], parser = new Parser(chunk => chunks.push(chunk.slice()));
      try {
        for (const [method, ...args] of handlers) parser[method](...args);
        for await (const chunk of response.body) await parser.write(chunk);
        await parser.end(); return new TextDecoder().decode(Buffer.concat(chunks));
      } finally { parser.free(); }
    }};
  }
};
const unit = '<p>Résumé 世界 🙂 and ordinary prose with <strong>nested text</strong>, <a href="/path?q=1">a link</a>, and <img src="/pic.png" alt="picture">.</p><pre>if (left &lt; right) return 1;</pre><nav>removed</nav>';
for (const [name, count, batch] of [['small', 24, 25], ['near-limit', Math.floor((1048576 - 13) / Buffer.byteLength(unit)), 2]]) {
  const html = '<main>' + unit.repeat(count) + '</main>';
  const output = await before(html, 'https://site.example/page');
  assert.equal(await after(html, 'https://site.example/page'), output);
  const samples = { before: [], after: [] };
  for (const convert of [before, after]) for (let i = 0; i < 5; i++) await convert(html, 'https://site.example/page');
  for (let sample = 0; sample < 9; sample++) {
    for (const [label, convert] of sample % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]]) {
      const start = performance.now();
      for (let i = 0; i < batch; i++) assert.equal(await convert(html, 'https://site.example/page'), output);
      samples[label].push((performance.now() - start) / batch);
    }
  }
  for (const values of Object.values(samples)) values.sort((a, b) => a - b);
  console.log({ name, inputBytes: Buffer.byteLength(html), outputBytes: Buffer.byteLength(output),
    sha256: createHash('sha256').update(output).digest('hex'), beforeMs: samples.before[4], afterMs: samples.after[4],
    beforeRange: [samples.before[0], samples.before[8]], afterRange: [samples.after[0], samples.after[8]] });
}
NODE
```

For a CPU profile, add `--cpu-prof --cpu-prof-dir=/tmp` before
`--input-type=module`; keep profiling artifacts outside the repository.

### Corrective paired benchmark (2026-10-04)

The reproduction above was rerun on clean corrective code commit
`47e6291ece0378587f1b67b45558e94bce2d9683`, versus full baseline
`431c0b1ac17f6b82a7f0ed8042c32ed906a4c0ae`, on Node v22.23.3,
Linux 6.17.0-1022-azure x86-64, AMD EPYC 9V74 (4 visible CPUs).
Candidate `markdown.js` SHA-256:
`7bb484bedd05d9a6c5eb9b76c16178b8e56aab4948745d9e97117d2465929c7d`.
Same corpus, locked parser, buffered adapter, warmups and alternating samples
as above; **every output compared equal**, with the same byte lengths and
SHA-256 hashes listed in the historical section.

| Input bytes | Baseline median (range), ms | Corrective median (range), ms |
|---|---|---|
| 5,101 | 1.042 (0.994–1.762) | 1.090 (0.995–1.507) |
| 1,048,565 | 200.753 (197.851–212.588) | 178.187 (172.737–201.093) |

No small-document improvement is demonstrated. A preceding working-tree run
under concurrent agent activity had much wider overlapping ranges: small
1.735 (1.267–5.910) versus 1.512 (1.220–4.640), near-limit
430.524 (226.861–728.156) versus 470.826 (191.301–572.691) ms.
This variability is why neither run is an edge CPU guarantee. The comparison
includes corrective safety handling as well as allocation optimization;
it does not isolate each change's cost. The near-limit input stays below 1 MiB,
but conversion here does not benchmark the Worker read/cancellation path.
Linked-image, query and adversarial context correctness is tested separately,
not inferred from this corpus. There is no claimed 95% saving or deployed gain.

### Corrective integration investigation (2026-10-04)

At investigation time `main` was
`432d109cb94e7bd09ce61c6ceb629f0e574edac5` and the old task branch
`copilot/implement-security-hardening-performance` ended at
`7c391cf3a0ff1de218bae2bb94806d3d7e9ae74b`. Only this corrective PR was open.
PR #41 merged at **2026-10-03 23:33:50 UTC**, with parents
`a94aca8f76251e5c1b43b1fc522c00ab386ac3ea` and
`b71e59e1ce48cb720f6007eeddd08d1f87002923`.
Its two integrated commits were the initial plan
`e2df5b5291cd19ab99461e25039862af83ea39bf` (23:30:40 UTC) and Phase 3.1
`b71e59e1ce48cb720f6007eeddd08d1f87002923` (23:32:17 UTC).
The first-parent diff contains README.md, the Worker and worker tests only:
**3 files, +122/-10**. `markdown.js` is byte-identical before/after that merge;
Phase 2.2 was **not** integrated in the deployed merge.

The six later commits are descendants of the merged head, but not ancestors
of main. All were authored/committed after the merge (times below are UTC):

| Original full commit | Time on 2026-10-03 | Change |
|---|---|---|
| `c74de0622a44da931036c750a33cb9f8a3e3fa41` | 23:36:35 | Phase 3.2 URL/label handling |
| `431c0b1ac17f6b82a7f0ed8042c32ed906a4c0ae` | 23:37:30 | Phase 3.3 forwarding fields |
| `cd97ca86714bf70ceeb5d70ca79b4699e8635d5d` | 23:41:13 | Phase 2.2 regex/text slicing |
| `0f3a1198bc28076c3ec2e51058304ab6b75b5224` | 23:41:52 | Phase 2.3 media type |
| `3319912302d4a4b603808baa8b5f084b712518be` | 23:46:14 | Query, IPv6, linked images |
| `7c391cf3a0ff1de218bae2bb94806d3d7e9ae74b` | 23:47:34 | Explicit backslash handling |

Thus the evidence supports **merging before task completion**, not speculative
merge conflicts. This corrective branch cherry-picked these verified commits
without conflicts, then added container/heading/title syntax-injection
regressions and fixes. These are local safety findings, not demonstrated live XSS.
The existing Phase 3.1 cache policy, HEAD optimization and CSP policy remain.

[Deployment run 37162179890](https://github.com/hgzvt98gtk-svg/hussamfaroug-com-worker/actions/runs/37162179890)
successfully deployed the above main commit with Worker version
`9bb53c2a-f680-4218-86b7-e2cf952cf721`. Its observability PATCH returned
`success: true` with invocation logs, tracing and query redaction enabled.
This is the latest accessible deployment evidence, not a fresh authenticated
query of current Cloudflare state. Invocation ingestion remains **unverified**:
no existing read authorization for logs is available here. This corrective PR
is **not merged or deployed**; do not attribute its tests to the live version.

### Read-only live verification

From an unrestricted machine with Node 22, in the repository root, run:

```sh
node scripts/live-smoke.mjs
```

No dependencies, credentials or Cloudflare API access are needed. The script
accepts **no target arguments** and follows no redirects: it only probes the
fixed public site, with GET/HEAD, sequentially. It checks anonymous and grouped
dummy-identity HTML/Markdown requests, copied CDN cache controls, descriptive
`/auth.md`, OAuth/OIDC and MCP discovery JSON (200, public one-hour cache and CORS),
representative retired service paths (404 and no-store),
public `/robots.txt` and a fixed `/favicon.ico` candidate. Static identity
coverage is skipped unless that candidate is actually a successful non-HTML
resource. Grouping all seven identity headers does not prove isolation for
each header separately, or arbitrary headers; local mocks test each recognized
header separately. Public Worker-generated metadata intentionally stays public.
It never changes ORIGIN, sends adversarial content, writes settings or deploys.

Exit 0 means all attempted HTTP assertions passed; exit 1 means an assertion or
network failure. Inspect `staticCoverage` and skipped counts even on success.
The report separates HTTP responses, DNS/transport failures and incomplete
bodies. Only successful, complete anonymous root GETs yield timing samples
(two HTML, one Markdown at most); they are client wall time, not Worker CPU.
For HEAD no-body behavior use its explicit checks, not a claimed percentage
speedup. A DNS error is not HTTP status 000 and is not endpoint latency.
Read the report's limitations before interpreting a result.

In this agent, the smoke attempt returned **0 HTTP responses**, 1 DNS error,
27 skipped checks and **no timing samples**. System lookup returned ENOTFOUND,
the configured resolver returned EREFUSED, and Google DoH and the known host
example.com also returned ENOTFOUND. Independent web-fetch attempts to Google
and Cloudflare DoH failed host lookup as well. This supports an agent-network
resolution limitation; authoritative/public DNS answers and live site behavior
remain **unverified**, not established as broken. No resolver, DNS record or
Cloudflare production setting was changed. Run the script outside this
restricted network before release; before merge it observes the old deployment.
Safe configuration inspection found one loopback nameserver with resolver
options/search configured, and no HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY
variables (upper/lowercase); no addresses, search domains or environment values
were published. No security restriction was bypassed.

Final local validation: **75 tests passed, 0 failed/skipped/cancelled**
(`npm test`, Node v22.23.3; 66 top-level plus 9 nested tests), including seven
smoke-script mock tests and rendered Markdown destination checks. No standalone
lint/build command exists. Mock header capture establishes what fetch receives,
not what Cloudflare later adds, and does not establish live origin header trust.
The full suite was also rerun on committed corrective code
`47e6291ece0378587f1b67b45558e94bce2d9683`; subsequent changes are documentation
only. Changed-file secret scans were clean and CodeQL found zero alerts.
Automated AI review was unavailable because its configured model was missing;
a separate read-only corrective-diff review found no significant issues.

## Cron trigger

No cron trigger or `scheduled()` handler is configured, so cache warming is not currently scheduled.
