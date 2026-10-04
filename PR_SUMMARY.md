# Validate Auth.md Metadata Discovery Chain

## Problem

The Auth.md routes and registration metadata existed but verification didn't validate the **links** between three critical pieces:
- Protected Resource metadata (`/.well-known/oauth-protected-resource`)
- Authorization Server metadata (`/.well-known/oauth-authorization-server`)  
- Manual registration documentation (`/auth.md`)

A malformed or inconsistent metadata chain could go undetected by deployment and live verification scripts.

## Solution

**New validation module:** `scripts/auth-metadata.mjs` — centralized chain validator used by both deployment and live monitoring checks.

### What Gets Validated

1. **URL Consistency**
   - Protected resource identifier matches origin
   - Authorization server issuer matches origin
   - Protected resource points to `{origin}/auth.md`
   - Agent auth register URI points to `{origin}/auth.md#agent-registration`

2. **Capability Boundary**
   - `agent_auth` object is present
   - `identity_types_supported` is an empty array (no automated identities)
   - `credential_types_supported` is an empty array (no automated credentials)
   - No `claim_endpoint` or `revocation_endpoint` (manual-only phase)

3. **Documentation Content**
   - `/auth.md` has `## Agent registration` section
   - Contains "registration is manual only"
   - Warns "do not POST registration requests"
   - Explains empty identity/credential type arrays
   - States no claim/revocation API exists
   - Notes claim/revocation URLs are omitted

### Code Example

```javascript
const issues = validateAuthMetadataChain({
  origin: "https://example.com",
  protectedResource: { 
    resource: "https://example.com",
    authorization_servers: ["https://example.com"],
    resource_documentation: "https://example.com/auth.md"
  },
  authorizationServer: {
    issuer: "https://example.com",
    agent_auth: {
      register_uri: "https://example.com/auth.md#agent-registration",
      identity_types_supported: [],
      credential_types_supported: []
    }
  },
  authMarkdown: "# Auth.md\n## Agent registration\n..."
});
// issues.length === 0 if valid
```

## Changes

| File | Changes | Impact |
|------|---------|--------|
| `scripts/auth-metadata.mjs` | NEW: 63 lines | Shared validation logic |
| `scripts/verify-deployment.mjs` | +40 lines | Uses validator, checks new `/oauth-authorization-server` endpoint |
| `scripts/live-smoke.mjs` | +25 lines | Collects metadata, validates chain, affects final `ok` status |
| `test/verify-deployment.test.mjs` | +55 lines | Uses real metadata builders, adds malformed chain tests |
| `test/live-smoke.test.mjs` | +19 lines | Tests broken link detection, DNS failure handling |
| `DEPLOYMENT_VERIFICATION.md` | +12 lines | Documents actual agent_auth structure |
| `README.md` | +8 lines | Clarifies what scripts validate |

## Test Coverage

✅ **105/105 tests pass**

- Valid metadata chain (deployment & live)
- Broken register_uri link detection
- Missing authorization-server endpoint
- Inconsistent origin references
- Malformed metadata (wrong type, missing agent_auth)
- Content-Type validation (`text/markdown` for auth.md)
- DNS failure handling (chain validation skipped)

## Known Limitation

Production verification was attempted but blocked by DNS resolution failure before reaching site endpoints. Manual verification recommended.

---

**Ready to merge.** All tests pass, no secrets detected. Deployment and live monitoring now share consistent acceptance criteria for the metadata chain.
