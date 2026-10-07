# Deployment verification

Use this checklist after deploying the Worker. It documents checks that are
actually available in this repository; it does not claim to exercise private
Cloudflare logs, force transient origin failures, stress-test the limiter, or
measure production latency.

## Automated smoke check

Run:

```sh
npm ci
npm test
node scripts/verify-deployment.mjs https://hussamfaroug.com
```

The verifier checks public OAuth/OIDC and MCP discovery metadata, `/auth.md`,
and a successful root response. Retry behavior, the rate-limit threshold, and
private metrics logging are reported as **NOT CHECKED**. A healthy root response
does not verify those behaviors.

## Representation and cache checks

```sh
curl -sS -D - -o /dev/null -H 'Accept: text/html' https://hussamfaroug.com/
curl -sS -D - -o /dev/null -H 'Accept: text/markdown' https://hussamfaroug.com/
curl -sS -I -H 'Accept: text/markdown' https://hussamfaroug.com/
```

- Transformed HTML and Markdown responses include `Vary: Accept`; existing
  origin `Vary` values are preserved. The Worker does not add `Vary: Origin`.
- Markdown `HEAD` skips reading and converting the origin body, so it does not
  include `x-markdown-tokens`.
- Proxied responses are marked `private, no-store` for the identity headers
  enumerated in `hussamfaroug-com-worker.js` and for upstream `Set-Cookie`.
  Public Worker-generated discovery metadata is intentionally exempt.
- This list is not an inventory of every identity-bearing input used by the
  origin. Before enabling personalized origin content, identify those inputs
  and verify cache policy through the deployed CDN. A forwarding header alone
  is not an identity-cache signal.

## Cloudflare-only checks

After deployment, verify in Cloudflare that observability settings were
successfully updated and that logs/traces arrive. The deployment workflow fails
if the API request fails or the API response does not confirm success, but this
repository cannot verify the resulting platform configuration or telemetry
delivery.

The request-path limiter is best-effort and isolate-local. Validate its
production behavior through an approved test environment rather than generating
a burst against the live site. Likewise, confirm origin retry behavior using a
controlled transient failure, not an ordinary successful request.

## Performance

Use `node scripts/benchmark-markdown.mjs` for local conversion measurements and
`node scripts/benchmark-production.mjs` for the read-only real-page benchmark.
The local benchmark uses Node/WASM; the production benchmark includes network
latency and may not expose conversion-stage timing. Neither alone establishes
Worker CPU cost or a production latency guarantee.

The detailed local pass analysis is in
[`MARKDOWN_GENERATION_PROFILING.md`](MARKDOWN_GENERATION_PROFILING.md). It
found protected-text restoration to be the dominant cost before the array/join
optimization; the optimized Markdown generation took roughly 76–89 ms on the
tested 500 KB local fixtures, while end-to-end conversion remained dominated by
the local WASM HTMLRewriter. Treat those as environment-specific measurements.
