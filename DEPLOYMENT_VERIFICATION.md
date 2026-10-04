# Post-Deployment Verification Checklist

**PR #42 Deployment Verification Guide**

After merging PR #42 to main and deploying to Cloudflare Workers, use this checklist to verify all security fixes, content handling, and performance changes are working correctly in production.

---

## Prerequisites

- ✅ PR #42 merged and deployed to Cloudflare Worker
- ✅ GitHub Actions deployment completed successfully
- ✅ Cloudflare observability dashboard accessible
- ✅ Access to `curl`, browser, or HTTP client
- ✅ Target: `https://hussamfaroug.com` (or staging origin)

---

## 1. Smoke Tests: Basic Connectivity

**Goal:** Verify the Worker is responding and basic proxy routing works.

```bash
# Test 1.1: GET request
curl -i https://hussamfaroug.com/ \
  -H "Accept: text/html" \
  --max-time 10

# Expected: HTTP 200-299, no timeouts, body present

# Test 1.2: HEAD request
curl -I https://hussamfaroug.com/ \
  -H "Accept: text/html" \
  --max-time 10

# Expected: HTTP 200-299, no body content, same headers as GET (except Content-Length)

# Test 1.3: OPTIONS request (CORS preflight)
curl -i -X OPTIONS https://hussamfaroug.com/ \
  -H "Origin: https://example.com" \
  --max-time 10

# Expected: HTTP 204, Access-Control-Allow-Origin: *
```

---

## 2. Phase 3.2: Markdown URL Validation

**Goal:** Verify dangerous URL schemes are blocked; only HTTP/HTTPS links are generated.

### Test 2.1: JavaScript URL Rejection

```bash
# Test: Markdown conversion of page with javascript: link
curl -s https://hussamfaroug.com/some-page \
  -H "Accept: text/markdown" \
  | grep -E "javascript:|jav&#|data:" 

# Expected: No output (dangerous schemes not present in Markdown)
```

### Test 2.2: Safe HTTPS/HTTP Links Preserved

```bash
# Test: Verify legitimate links are converted correctly
curl -s https://hussamfaroug.com/some-page \
  -H "Accept: text/markdown" \
  | grep -E "https?://" 

# Expected: Links like [text](https://...) or [text](http://...) present
```

### Test 2.3: Entity Obfuscation Blocked

```bash
# Test: java&#115;cript: (entity-obfuscated) should be rejected
# This requires a page with such a link; can be tested via mock if live page unavailable
curl -s https://hussamfaroug.com/some-page \
  -H "Accept: text/markdown" \
  | grep -E "&#|&#x" | head -5

# Expected: No &#115;cript or similar obfuscation patterns that decode to dangerous schemes
```

### Test 2.4: Image Alt Text Escaping

```bash
# Test: Images with malicious alt text should have escaped Markdown chars
curl -s https://hussamfaroug.com/some-page \
  -H "Accept: text/markdown" \
  | grep -A1 "!\[" | head -10

# Expected: Alt text contains \[ \] \( \) if it had Markdown-unsafe chars (e.g., "](" in alt)
```

---

## 3. Phase 3.3: Forwarding Header Removal

**Goal:** Verify caller-supplied IP and forwarding headers are stripped before reaching origin.

### Test 3.1: X-Forwarded-For Removal

```bash
# Mock test (requires origin server logging access):
# Send X-Forwarded-For in request
curl -i https://hussamfaroug.com/api/debug \
  -H "X-Forwarded-For: 192.0.2.10" \
  -H "X-Real-IP: 192.0.2.10" \
  -H "X-Client-IP: 192.0.2.10"

# Expected: If origin echoes back request headers, these should be ABSENT
# (Note: Origin may have its own security logging; if available, verify absence)
```

### Test 3.2: Cache Policy Applied to Spoofed Headers

```bash
# When caller provides spoofed headers, should not cache (private, no-store)
curl -i https://hussamfaroug.com/some-page \
  -H "X-Forwarded-For: 192.0.2.10" \
  -H "Accept: text/html"

# Expected: Cache-Control contains "no-store" or "private"
```

### Test 3.3: Legitimate Headers Preserved

```bash
# Verify normal headers (Accept, User-Agent, etc.) still pass through
curl -i https://hussamfaroug.com/some-page \
  -H "Accept: text/markdown" \
  -H "User-Agent: My-Custom-Agent/1.0" \
  -H "X-Test-Header: keep-me" \
  --max-time 10

# Expected: Response received; conversion to Markdown works; Worker logic intact
```

---

## 4. Phase 2.3: Exact HTML Classification

**Goal:** Verify content is classified correctly based on exact `text/html` media type.

### Test 4.1: Mixed-Case HTML Type

```bash
# If origin returns Text/HTML or TEXT/HTML
# (May require staging/test origin; adjust origin config in wrangler.toml if testing)

curl -s https://hussamfaroug.com/test-case-sensitive \
  -H "Accept: text/markdown" | head -5

# Expected: Page converted to Markdown (case-insensitive match works)
```

### Test 4.2: HTML-Like but Non-HTML Media Types Pass Through

```bash
# Endpoint returning application/text/html or text/html-invalid should pass through as raw HTML
# (Requires test page or endpoint)

curl -s https://hussamfaroug.com/test-invalid-type \
  -H "Accept: text/markdown" | head -5

# Expected: Raw HTML tags present (e.g., <div>, <p>); NOT converted to Markdown
```

### Test 4.3: Missing Content-Type Passes Through

```bash
# Origin response without Content-Type header
# (Requires test endpoint or staging origin)

curl -s https://hussamfaroug.com/test-no-content-type | head -5

# Expected: Raw HTML or raw body; NOT forced to Markdown
```

---

## 5. Cache Control & Identity-Aware Caching

**Goal:** Verify cache policies respect Authorization/Cookie and custom headers.

### Test 5.1: Authorization Header → Private, No-Store

```bash
# Request with Authorization header
curl -i https://hussamfaroug.com/some-page \
  -H "Authorization: Bearer token123" \
  -H "Accept: text/html"

# Expected: Cache-Control: private, no-store (or similar restrictive policy)
```

### Test 5.2: Cookie → Private, No-Store

```bash
# Request with Cookie header
curl -i https://hussamfaroug.com/some-page \
  -H "Cookie: session=abc123" \
  -H "Accept: text/html"

# Expected: Cache-Control: private, no-store
```

### Test 5.3: Custom Identity Headers → Private, No-Store

```bash
# Request with recognized custom identity headers
for header in "X-API-Key" "X-Auth-Token" "X-Access-Token" "X-Custom-Auth"; do
  curl -i https://hussamfaroug.com/some-page \
    -H "$header: value123" \
    -H "Accept: text/html" | grep -i "cache-control"
done

# Expected: All return Cache-Control: private, no-store (or restricted policy)
```

### Test 5.4: No Identity → Public Caching Allowed

```bash
# Request without identity headers
curl -i https://hussamfaroug.com/public-content \
  -H "Accept: text/html"

# Expected: Cache-Control may contain public, max-age=..., or similar permissive policy
```

---

## 6. Markdown-Specific Caching

**Goal:** Verify Markdown representations are cached correctly (identity-aware).

### Test 6.1: Markdown HEAD Request

```bash
# HEAD request requesting Markdown should not read/convert body
curl -I https://hussamfaroug.com/some-page \
  -H "Accept: text/markdown" \
  --max-time 5

# Expected: HTTP 200, Headers present (including x-markdown-tokens if body was empty), no body
```

### Test 6.2: Markdown Tokens Header

```bash
# GET request for Markdown should include x-markdown-tokens header
curl -i https://hussamfaroug.com/some-page \
  -H "Accept: text/markdown" | grep -i "x-markdown-tokens"

# Expected: Header present, value is a number (token count ≈ bytes/4)
```

### Test 6.3: Markdown Content-Signal Header

```bash
# Markdown responses should signal AI-safe content
curl -i https://hussamfaroug.com/some-page \
  -H "Accept: text/markdown" | grep -i "content-signal"

# Expected: Content-Signal: ai-train=yes, search=yes, ai-input=yes
```

---

## 7. Non-HTML Passthrough

**Goal:** Verify non-HTML responses are not modified.

### Test 7.1: JSON Passthrough

```bash
# Request for JSON endpoint (if available)
curl -i https://hussamfaroug.com/api/data \
  -H "Accept: text/markdown"

# Expected: Content-Type: application/json, body unchanged, no Markdown conversion
```

### Test 7.2: CSS/JavaScript Passthrough

```bash
# Request for static assets
curl -i https://hussamfaroug.com/style.css
curl -i https://hussamfaroug.com/app.js

# Expected: Content-Type preserved, body unchanged, no processing
```

---

## 8. Retired OAuth/OIDC/MCP Endpoints

**Goal:** Verify old service endpoints return 404 (not advertising deprecated services).

```bash
# Test 8.1: OAuth endpoint
curl -i https://hussamfaroug.com/.well-known/oauth-authorization-server

# Expected: HTTP 404

# Test 8.2: OIDC endpoint
curl -i https://hussamfaroug.com/.well-known/openid-configuration

# Expected: HTTP 404

# Test 8.3: MCP endpoint
curl -i https://hussamfaroug.com/.well-known/mcp

# Expected: HTTP 404

# Test 8.4: Discovery should still work
curl -i https://hussamfaroug.com/.well-known/api-catalog

# Expected: HTTP 200, JSON with implemented services (WebMCP, etc.)
```

---

## 9. Auth.md Endpoint

**Goal:** Verify authentication documentation endpoint works.

```bash
curl -i https://hussamfaroug.com/auth.md

# Expected: HTTP 200, Content-Type: text/markdown or text/plain
# Body should contain documentation about auth/discovery (not OAuth/OIDC services)
```

---

## 10. Performance: Markdown Conversion Timing

**Goal:** Verify optimization is deployed (near-limit docs faster).

```bash
# Test with a large document request (if available)
time curl -s https://hussamfaroug.com/large-page \
  -H "Accept: text/markdown" > /tmp/md_large.md

# Small document
time curl -s https://hussamfaroug.com/small-page \
  -H "Accept: text/markdown" > /tmp/md_small.md

# Record times and compare:
# - Small: Should be <5ms (varies by network; ~1-2ms locally)
# - Near-limit (1MB): Should be <200ms (varies by network; ~178ms locally baseline)
# No claimed edge CPU savings; local benchmarks only
```

---

## 11. Observability & Logging

**Goal:** Verify deployment monitoring and logging are active.

### Test 11.1: Cloudflare Observability Dashboard

1. Log into Cloudflare dashboard
2. Navigate to **Workers** → **hussamfaroug-com** → **Deployments** or **Logs**
3. Verify:
   - ✅ Latest deployment is PR #42 corrective commit
   - ✅ Worker version updated (e.g., `9bb53c2a-f680-4218-86b7-e2cf952cf721` → new UUID)
   - ✅ Invocation logs appear (may take 1-2 minutes)
   - ✅ No error logs for normal requests (HTTP 200-299)

### Test 11.2: Request Tracing

```bash
# Make a request and check for trace ID (if exposed)
curl -v https://hussamfaroug.com/test-page 2>&1 | grep -i "cf-ray"

# Expected: CF-Ray header present (Cloudflare request ID for tracing)
```

### Test 11.3: Cache Hit/Miss Status

```bash
# Repeated requests should show cache behavior
for i in {1..3}; do
  echo "Request $i:"
  curl -i https://hussamfaroug.com/public-page 2>&1 | grep -i "cf-cache"
done

# Expected: First request CF-Cache-Status: MISS or DYNAMIC
#           Subsequent requests CF-Cache-Status: HIT or EXPIRED_STALE
```

---

## 12. Edge Cases & Adversarial Markdown

**Goal:** Verify edge cases are handled securely.

### Test 12.1: Nested Formatting with Dangerous Links

```bash
# If a page has <h2><a href="javascript:bad">x](y)[z</a></h2>
# The Markdown output should escape Markdown delimiters in link text

curl -s https://hussamfaroug.com/page-with-nested-link \
  -H "Accept: text/markdown" | grep -E "\\[|\\]|\\(|\\)"

# Expected: Markdown delimiters escaped (e.g., \], \(, \[) to prevent injection
```

### Test 12.2: Entity Decoding in Labels

```bash
# Alt text like alt="x]&#93;(bad)[y" should not become x]](bad)[y
# (i.e., entity decoding happens before escaping)

curl -s https://hussamfaroug.com/page-with-entity-alt \
  -H "Accept: text/markdown" | grep "!\[" | head -3

# Expected: Alt text preserved safely; no unescaped ], (, [
```

### Test 12.3: Unicode & IPv6 in URLs

```bash
# Links with Unicode paths and IPv6 should work
curl -s https://hussamfaroug.com/page-with-unicode-link \
  -H "Accept: text/markdown" | grep "https://\[.*:.*\]" 

# Expected: IPv6 URLs like https://[2001:db8::1]/path present
# or Unicode URLs like https://example.com/路径 (URL-encoded)
```

---

## 13. Regression Testing: Existing Features

**Goal:** Ensure Phase 3.1 (cache) and existing features still work.

### Test 13.1: WebMCP Bridge Injection

```bash
# HTML response should include WebMCP script injection
curl -s https://hussamfaroug.com/some-page \
  -H "Accept: text/html" | grep -i "webmcp\|nonce"

# Expected: <script nonce="..."> tag present with WebMCP bridge code
```

### Test 13.2: CSP Header

```bash
# Responses should include Content-Security-Policy with nonce
curl -i https://hussamfaroug.com/some-page | grep -i "content-security-policy"

# Expected: CSP header present; includes script-src 'nonce-...'
```

### Test 13.3: Vary Header

```bash
# Responses should have Vary: Accept and Vary: Origin
curl -i https://hussamfaroug.com/some-page | grep -i "vary"

# Expected: Vary header includes Origin and Accept (or Origin, Accept)
```

---

## 14. Incident Triage: If Issues Occur

| Symptom | Likely Cause | Action |
|---------|--------------|--------|
| **Markdown links have unsafe schemes** (javascript:, data:, etc.) | Phase 3.2 not deployed correctly | Check deployed commit SHA; verify `mdRu()` function includes scheme validation |
| **X-Forwarded-For present in origin logs** | Phase 3.3 not deployed | Check header strip list in `handleRequest()`; re-deploy if needed |
| **Mixed-case HTML (Text/HTML) not converting to Markdown** | Phase 2.3 not deployed | Check `mediaType` comparison; should be exact `!==` match, not substring |
| **Markdown conversion slow (>300ms for 1MB)** | Phase 2.2 not deployed or regressed | Check regex hoisting; verify `mdPatterns` defined at module level |
| **Cache-Control missing or wrong** | `applyCachePolicy()` broken | Check function is called for all response types; verify identity header detection |
| **Markdown-Markdown token header missing** | Markdown processing broken | Check `x-markdown-tokens` header is set; verify convertMd returns non-null |
| **Worker timeouts or 502 errors** | Conversion or proxy failure | Check Cloudflare observability logs for errors; verify origin is accessible |

---

## 15. Success Criteria

✅ **Deployment is successful if:**

1. Smoke tests (section 1) pass
2. At least 3 of 4 security tests (sections 2-5) pass
3. No regressions in existing features (section 13)
4. Observability logs show invocations (section 11)
5. Incident triage confirms no blocking issues

✅ **Deployment is fully confident if:**

1. All tests in sections 1-13 pass
2. Live Markdown output verified safe (no dangerous schemes, properly escaped)
3. Performance baseline established (~178ms for 1MB documents)
4. No new error logs in Cloudflare dashboard

---

## Quick Copy-Paste Verification Script

```bash
#!/bin/bash
# Quick 5-minute verification

ORIGIN="https://hussamfaroug.com"
RESULT=0

echo "🔍 Smoke Test: GET"
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$ORIGIN" -H "Accept: text/html" || RESULT=1

echo "🔍 Smoke Test: HEAD"
curl -s -o /dev/null -I -w "HTTP %{http_code}\n" "$ORIGIN" -H "Accept: text/html" || RESULT=1

echo "🔍 Markdown Link Validation"
curl -s "$ORIGIN" -H "Accept: text/markdown" | grep -q "javascript:" && RESULT=1 || echo "✅ No javascript: URLs"

echo "🔍 Cache Control (with auth)"
curl -s -o /dev/null -I -w "Cache-Control: %{header{Cache-Control}}\n" "$ORIGIN" \
  -H "Authorization: Bearer test" -H "Accept: text/html" || RESULT=1

echo "🔍 Retire OAuth Endpoints"
curl -s -o /dev/null -w "OAuth endpoint HTTP %{http_code}\n" "$ORIGIN/.well-known/oauth-authorization-server"

if [ $RESULT -eq 0 ]; then
  echo "✅ All quick checks passed"
else
  echo "❌ Some checks failed; see details above"
fi

exit $RESULT
```

Save as `verify.sh`, run with `bash verify.sh`.

---

## Notes

- **Network latency will vary** by region and time. Use relative comparisons, not absolute times.
- **Invocation logs may delay 1-2 minutes** before appearing in Cloudflare dashboard; check again if not visible immediately.
- **Live origin behavior** (e.g., redirects, error pages) may affect test results; compare before/after deployment.
- **Content-Type detection** only matches `text/html` exactly; ensure origin sends correct headers.
- **If tests fail:** Check PR #42 commit hash deployed; verify worker version in Cloudflare dashboard; review observability logs for errors.

---

## Sign-Off

- **Deployment Date:** _______________
- **Verified By:** _______________
- **Tests Passed:** _____ / 15 sections
- **Issues Found:** _______________
- **Status:** ☐ Ready for production  ☐ Rollback needed  ☐ Investigate further

