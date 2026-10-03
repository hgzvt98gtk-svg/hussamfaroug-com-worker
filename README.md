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
- `proxy.js` — Accept negotiation, bounded HTML reads, and origin request lifecycle

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

Public discovery describes implemented resources and the browser-only
`get_site_info` WebMCP tool. OAuth/OIDC, A2A, and HTTP MCP services are not
implemented; their former endpoints return 404 instead of advertising support.
`/auth.md` documents public access, not credential registration.

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

### Markdown benchmark (Phase 2.2)

Measured on Node v22.23.3, Linux 6.17.0-1022-azure x86-64, Intel Xeon Platinum
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
BASE_REF=431c0b1 node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HTMLRewriter as Parser } from 'html-rewriter-wasm';
import { convertMd as after } from './markdown.js';
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

## Cron trigger

No cron trigger or `scheduled()` handler is configured, so cache warming is not currently scheduled.
