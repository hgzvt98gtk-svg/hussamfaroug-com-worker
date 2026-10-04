import assert from "node:assert/strict";
import test from "node:test";
import { authMd, oauthAuthorizationServer, oauthProtectedResource } from "../metadata.js";
import { validateAuthMetadataChain } from "../scripts/auth-metadata.mjs";

const origin = "https://example.com";
const chain = async () => ({
  origin,
  protectedResource: await oauthProtectedResource(origin).json(),
  authorizationServer: await oauthAuthorizationServer(origin).json(),
  authMarkdown: await authMd(origin).text()
});

test("published manual-only Auth.md discovery chain is valid", async () => {
  assert.deepEqual(validateAuthMetadataChain(await chain()), []);
});

test("manual instructions allow Markdown formatting and wording changes", async () => {
  const data = await chain();
  data.authMarkdown = [
    "# Authentication",
    "",
    `[OpenID configuration](${origin}/.well-known/openid-configuration)`,
    `[Resource metadata](${origin}/.well-known/oauth-protected-resource)`,
    `[Authorization server](${origin}/.well-known/oauth-authorization-server)`,
    "",
    "### Agent Registration ###",
    "",
    `[Registration instructions](${origin}/auth.md#agent-registration)`,
    "Contact [the administrator](mailto:admin@example.com) to coordinate registration manually.",
    "Public content needs no credentials. Automated registration and credential services are unavailable."
  ].join("\r\n");
  assert.deepEqual(validateAuthMetadataChain(data), []);
});

test("missing and malformed PRM or authorization server metadata are rejected", async () => {
  for (const field of ["protectedResource", "authorizationServer"]) {
    for (const value of [undefined, null, [], {}, "not metadata", 42]) {
      const data = await chain();
      data[field] = value;
      assert.ok(validateAuthMetadataChain(data).length, `${field}: ${JSON.stringify(value)}`);
    }
  }
});

test("metadata must link the same origin and root manual registration document", async () => {
  for (const mutate of [
    data => { data.protectedResource.resource = "https://other.example"; },
    data => { data.protectedResource.authorization_servers = ["https://other.example"]; },
    data => { data.protectedResource.resource_documentation = origin + "/docs/auth.md"; },
    data => { data.authorizationServer.issuer = "https://other.example"; },
    data => { delete data.authorizationServer.agent_auth.skill; },
    data => { data.authorizationServer.agent_auth.skill = origin + "/docs/auth.md"; },
    data => { data.authorizationServer.agent_auth.register_uri = origin + "/auth.md"; },
    data => { data.authorizationServer.agent_auth.register_uri = "https://other.example/auth.md#agent-registration"; },
    data => { data.authorizationServer.agent_auth.register_uri = origin + "/auth.md#missing-section"; }
  ]) {
    const data = await chain();
    mutate(data);
    assert.ok(validateAuthMetadataChain(data).length);
  }
});

test("unsupported identity, credential, claim, revocation and registration capabilities are rejected", async () => {
  for (const mutate of [
    data => { delete data.authorizationServer.agent_auth; },
    data => { data.authorizationServer.agent_auth = []; },
    data => { delete data.authorizationServer.agent_auth.identity_types_supported; },
    data => { data.authorizationServer.agent_auth.identity_types_supported = ["anonymous"]; },
    data => { data.authorizationServer.agent_auth.credential_types_supported = ["api_key"]; },
    data => { data.authorizationServer.agent_auth.credential_types_supported = "none"; },
    ...["claim_endpoint", "revocation_endpoint", "registration_endpoint"].map(key =>
      data => { data.authorizationServer.agent_auth[key] = origin + "/unimplemented"; }),
    ...["registration_endpoint", "claim_endpoint", "revocation_endpoint"].map(key =>
      data => { data.authorizationServer[key] = origin + "/unimplemented"; }),
    ...["authorization_endpoint", "token_endpoint", "jwks_uri", "grant_types_supported", "response_types_supported",
      "scopes_supported", "token_endpoint_auth_methods_supported"].map(key =>
      data => { data.authorizationServer[key] = origin + "/unimplemented"; })
  ]) {
    const data = await chain();
    mutate(data);
    assert.ok(validateAuthMetadataChain(data).length);
  }
});

test("Auth.md must contain a discoverable registration section, contact and discovery links", async () => {
  for (const mutate of [
    () => undefined,
    () => "",
    text => text.replace("## Agent registration", "## Contact"),
    text => text.replaceAll("mailto:", ""),
    text => text.replaceAll(/\bmanual(?:ly)?\b/gi, "automatic"),
    text => text.replaceAll(origin + "/.well-known/openid-configuration", ""),
    text => text.replaceAll(origin + "/.well-known/oauth-protected-resource", ""),
    text => text.replaceAll(origin + "/.well-known/oauth-authorization-server", "")
  ]) {
    const data = await chain();
    data.authMarkdown = mutate(data.authMarkdown);
    assert.ok(validateAuthMetadataChain(data).length);
  }
});
