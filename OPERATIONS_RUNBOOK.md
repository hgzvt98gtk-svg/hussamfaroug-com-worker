# Operations runbook

## Scope and ownership

Service: Cloudflare Worker `hussamfaroug-com`, serving
`https://hussamfaroug.com/*`. Configuration is in `wrangler.toml`; the current
upstream is `https://hgzvt98gtk-svg-github-io.pages.dev`, configured as `ORIGIN`.
`SITE_CONFIG` is the signing-key KV binding. Contact the service owner at
**admin@hussamfaroug.com** for incidents, access, and manual agent registration.
No staffed on-call rotation, alert destination, or third-party monitoring
integration is provisioned by these documents.

This is a public, read-only proxy. GET/HEAD are supported; OPTIONS returns 204
and unsupported methods return 405. OAuth/OIDC discovery is metadata, not token
issuance or validation. WebMCP is browser-only, not an HTTP MCP server.

## Incident response

1. Record UTC start time, Worker deployment/version and commit, affected paths,
   representation, status, region, and safe `CF-Ray` identifiers.
2. Notify admin@hussamfaroug.com. Do not send credentials, cookies, private JWKs,
   sensitive URLs/query strings, or response bodies in tickets or alerts.
3. Compare current edge response-status logs and actual request latency with
   the previous healthy deployment. Check log ingestion and sampling before
   treating missing data as recovery.
4. Check Cloudflare service health, then test the Worker and configured origin
   independently. Distinguish origin failure, conversion failure, configuration
   error, and deliberate rate limiting.
5. If correlated with a release, use the rollback procedure below. Confirm
   recovery with smoke checks and fresh status/latency windows.

See [MONITORING_SETUP.md](MONITORING_SETUP.md) for alert sources, denominators,
minimum traffic, and the limits of application metrics.

### Safe connectivity checks

```bash
curl -sS -D - -o /dev/null --max-time 15 \
  -H 'Accept: text/html' https://hussamfaroug.com/
curl -sS -D - -o /dev/null --max-time 15 \
  -H 'Accept: text/markdown' https://hussamfaroug.com/
curl -sS -I --max-time 15 \
  -H 'Accept: text/markdown' https://hussamfaroug.com/
curl -sS -D - -o /dev/null --max-time 15 \
  https://hgzvt98gtk-svg-github-io.pages.dev/
curl -sS -D - -o /dev/null --max-time 15 \
  https://hussamfaroug.com/.well-known/http-message-signatures-directory
```

Use the deployed `ORIGIN` if it differs from the checked-in value. Inspect
redirects before following them: the Worker uses manual origin redirects.
Markdown HEAD deliberately skips body reading/conversion and omits
`x-markdown-tokens`; it is not a conversion health check.

## Origin, network, and conversion failures

| Symptom | Investigation and action |
| --- | --- |
| 500 `Origin configuration unavailable` | Verify `ORIGIN` exists, uses HTTP(S), contains no credentials, and differs from the public Worker origin. Check deployed variables rather than only the repository. |
| 502 `Origin unavailable` | Check DNS, TLS, connectivity, origin availability, retry logs, and client cancellation. Compare direct origin requests from a comparable region; a local success alone does not prove edge reachability. |
| Origin HTTP 5xx | Compare origin status logs with edge status logs. HTTP errors are passed through and are **not** retried. `errors_origin` counts upstream 5xx, not just upstream 502. |
| 502 `Origin conversion unavailable` | Compare HTML versus Markdown on the same path. Check exact `text/html` Content-Type, failed/slow body reads, the 1 MiB read limit, malformed content, and converter regressions. The conversion-error counter includes body-read failures. |
| Truncated/failed streamed HTML or non-HTML response | Inspect platform exceptions and origin body transfer. Headers can already have been sent, so a streaming failure need not become a final HTTP 502. |
| Signing directory 503 | Verify `SITE_CONFIG` binding and valid matching Ed25519 private/public JWK components at `BOT_AUTH_PRIVKEY_JWK`; never print the private key. This failure is separate from origin health. |

Origin timeout is 10 seconds and covers headers and body transfer. Initial
network fetch failures can retry once after 100 ms; HTTP error statuses and
already-started body-read failures are not retried. Client disconnection cancels
work and stops additional retries. A cancelled request is not necessarily an
origin outage. Do not raise timeouts or retries blindly: that increases
concurrency, origin load, and user latency.

### Slow responses

Use actual per-request wall-clock duration from a configured edge request log
source, trace, or controlled synthetic probe; do not use CPU time as latency.
Compare regions, cold starts, representation, document size, and origin health.
Initial p99 targets are **HTML <100 ms** and **Markdown <300 ms**, not guarantees;
establish achievable production baselines before treating them as SLOs.

The random 1% component samples expose cumulative duration sums and sample
counts for origin fetch, HTML reading, conversion, header processing, and token
estimation. Compute reset-safe interval means as described in the monitoring
guide. High origin mean suggests network/header/retry delay; high readHtml mean
suggests slow or large bodies; high conversion mean suggests content size or
converter work; headers/token means help localize processing overhead. These
components do not describe complete streamed-response latency and cannot yield
p99. `conversion_avg_ms` averages all recorded conversions, including failed
conversion attempts whose timing is recorded; it is not a sampled percentile.

For a reproducible local converter comparison:

```bash
node scripts/benchmark-markdown.mjs
```

Local benchmark results exclude edge/network latency and are not production
CPU, memory, or p99 guarantees. Avoid conversion stress tests on the live site.

## Rate limiting and excessive 429s

GET/HEAD share a best-effort limit of 100 requests/minute per
`CF-Connecting-IP` in each isolate. Missing addresses share an `unknown` bucket;
state is bounded to 10,000 clients and is not shared across isolates or regions.
429 responses carry `Retry-After: 60` and `Cache-Control: no-store`.

Check trusted platform client-IP availability, NAT/shared-proxy traffic, bursts,
bot retries, and distribution by region. Ask clients to honor Retry-After and
use backoff. Do not indiscriminately whitelist proxies or trust caller-supplied
forwarding headers. Any exemption must have a verified identity, narrow scope,
expiry, and abuse review; the current limiter has no allowlist configuration.
Use separately configured Cloudflare WAF/rate-limiting rules when a stronger
edge policy is required; these documents do not create them.

## Cache and identity safety

The proxy strips cookies, Authorization, forwarding identity, and other
sensitive/hop-by-hop headers before origin fetch. It is not an authenticated
origin gateway. Arbitrary custom identity headers are not all recognized.

Proxied responses use `private, no-store` when the original request has
Authorization, Cookie, X-API-Key, X-Auth-Token, X-Access-Token, Bearer, or
X-Custom-Auth, or when upstream sends Set-Cookie. Copied CDN cache-control
variants are also restricted. Static discovery metadata remains public.
Anonymous origin cache directives are preserved; Markdown defaults to no-store
only when upstream Cache-Control is absent. There is no explicit Worker Cache
API cache implemented here.

```bash
curl -sS -D - -o /dev/null --max-time 15 \
  -H 'Authorization: ******' -H 'Accept: text/html' \
  https://hussamfaroug.com/
curl -sS -D - -o /dev/null --max-time 15 \
  -H 'X-Custom-Auth: cache-policy-probe' -H 'Accept: text/markdown' \
  https://hussamfaroug.com/
```

`******` is a **dummy header value**, not a usable credential. Header presence
should trigger no-store on proxied content; never substitute production secrets
in shell history or logs. A forwarding-header-only request does not necessarily
trigger no-store. Check `Vary: Accept` on transformed responses and verify CDN
cache rules respect representation and private/no-store policies. Do not assume
repeated requests become cache hits. If leakage is suspected, restrict caching,
purge affected CDN objects through authorized Cloudflare controls, preserve
redacted evidence, and escalate immediately.

## Signing-key rotation and recovery

1. Arrange an authorized maintenance window and notify directory consumers.
   Preserve the previous key securely for an approved rollback; never commit it.
2. Generate/validate a matching Ed25519 private JWK using approved tooling and
   update `BOT_AUTH_PRIVKEY_JWK` in the correct `SITE_CONFIG` KV namespace.
3. Allow for **KV propagation**, the **60-second per-isolate local key cache**,
   and **240-second public directory response caching**. The 60 seconds is not a
   KV TTL or a global propagation bound.
4. Probe the directory from multiple locations; verify public `kid`, signature
   headers, and cryptographic validity. The signature advertises a 300-second
   lifetime. Account for stale consumers and cached older responses.
5. The implementation publishes one key, with no multi-key overlap mechanism;
   coordinate rotations accordingly. For compromise, revoke/purge through
   authorized controls and notify consumers rather than promising immediate
   global revocation.

A code rollback does not restore KV contents, and a key rollback has the same
propagation/cache delays. Invalid/missing key material returns non-cacheable
503, not silently generated replacement keys.

## Deployment and rollback

Before release, with Node.js 22 and the existing repository dependencies:

```bash
npm ci
npm test
node scripts/benchmark-markdown.mjs
```

Pushes to main deploy only after the test job; inspect the GitHub Actions
deployment result and Cloudflare active version. Do not bypass failed checks.
The workflow also attempts to enable observability; verify the settings and a
real invocation in Cloudflare rather than assuming that step worked.

After deployment:

```bash
node scripts/verify-deployment.mjs
node scripts/verify-deployment.mjs https://hussamfaroug.com
```

The verifier is an endpoint smoke check: it does not induce retries, stress the
rate limiter, inspect private metrics logs, verify signatures cryptographically,
or establish latency percentiles. Also inspect HTML/Markdown, CSP, Vary,
identity-aware caching, signing directory health, and new status/latency windows.

To roll back:

1. Record the bad and last-known-good Worker version IDs and related commits.
2. In Cloudflare Workers → `hussamfaroug-com` → deployments/version history,
   select an available known-good version and use the platform rollback control.
   Review its variables/bindings before activation; if unavailable, revert the
   offending commit through the repository review/deployment workflow.
3. Coordinate concurrent releases so an automatic deployment does not overwrite
   the rollback. Revert the code in main through normal review to make recovery
   persistent.
4. Verify active version, route, `ORIGIN`, `SITE_CONFIG`, observability, and smoke
   checks. KV contents, origin changes, CDN cache rules, and external monitoring
   settings require separate recovery; they are not automatically restored.
5. Check actual 5xx/429 rates and latency for a fresh complete window. Keep the
   incident open if traffic is too low or telemetry is missing to prove recovery.

Close with UTC timeline, root cause, affected versions/regions, mitigation,
verification evidence, and follow-up owners. Review targets and capacity using
production evidence, not only passing smoke checks.
