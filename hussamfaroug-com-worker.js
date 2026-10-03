var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// hussamfaroug-com-worker.js — Canonical deployed version (Oct 3, 2026)
// Security patches applied: hop-by-hop header filtering, HSTS preload, b64u chunking
// Crash fixes applied: origin fetch try/catch (502 fallback), null-body guard for HTMLRewriter
// KV binding: SITE_CONFIG (bot-auth key persistence)
// Observability: Logs + Traces enabled (100% sampling)
// Cron: none (removed — was causing 48 exceptions/day)

var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
var O = "https://hgzvt98gtk-svg-github-io.pages.dev";
var C = "admin@hussamfaroug.com";
var encoder = new TextEncoder();
var PUBLIC_CACHE_CONTROL = "public, max-age=3600";
function b64u(b) {
  var s = "";
  for (var i = 0; i < b.length; i += 8192) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64u, "b64u");
__name2(b64u, "b64u");
function cachedJson(data, options) {
  options = options || {};
  return new Response(JSON.stringify(data, null, 2), { headers: {
    "Content-Type": options.contentType || "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": options.cacheControl || PUBLIC_CACHE_CONTROL
  } });
}
__name(cachedJson, "cachedJson");
__name2(cachedJson, "cachedJson");
var botAuthKeyPromise = null;
async function buildBotAuthKey(privJwk) {
  if (!privJwk || privJwk.kty !== "OKP" || privJwk.crv !== "Ed25519" || typeof privJwk.x !== "string" || typeof privJwk.d !== "string") {
    throw new Error("invalid bot auth private key");
  }
  var ck = await crypto.subtle.importKey("jwk", privJwk, { name: "Ed25519" }, false, ["sign"]);
  var x = privJwk.x;
  var vk = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x }, { name: "Ed25519" }, false, ["verify"]);
  var probe = encoder.encode("bot-auth-key-check");
  if (!await crypto.subtle.verify("Ed25519", vk, await crypto.subtle.sign("Ed25519", ck, probe), probe)) {
    throw new Error("bot auth private key does not match its public component");
  }
  var kid = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })))));
  var body = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid, x, alg: "EdDSA" }] });
  return { ck, kid, body };
}
__name(buildBotAuthKey, "buildBotAuthKey");
__name2(buildBotAuthKey, "buildBotAuthKey");
async function loadBotAuthKey(kv) {
  var t0 = Date.now();
  var privJwkStr = null;
  if (kv) {
    privJwkStr = await kv.get("BOT_AUTH_PRIVKEY_JWK");
    if (privJwkStr === null) {
      var pubJwkStr = await kv.get("BOT_AUTH_PUBKEY_JWK");
      if (pubJwkStr !== null) throw new Error("bot auth public key present without private key");
    }
  }
  var t1 = Date.now();
  var key;
  if (privJwkStr !== null) {
    key = await buildBotAuthKey(JSON.parse(privJwkStr));
  } else {
    var kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    var privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    key = await buildBotAuthKey(privJwk);
    if (kv) {
      var pubJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
      await kv.put("BOT_AUTH_PRIVKEY_JWK", JSON.stringify(privJwk));
      await kv.put("BOT_AUTH_PUBKEY_JWK", JSON.stringify(pubJwk));
      var storedPriv = await kv.get("BOT_AUTH_PRIVKEY_JWK");
      if (storedPriv === null) throw new Error("bot auth private key not readable after write");
      var stored = JSON.parse(storedPriv);
      if (stored.d !== privJwk.d) key = await buildBotAuthKey(stored);
    }
  }
  console.log("bot auth key loaded: kv " + (t1 - t0) + "ms, crypto " + (Date.now() - t1) + "ms");
  return key;
}
__name(loadBotAuthKey, "loadBotAuthKey");
__name2(loadBotAuthKey, "loadBotAuthKey");
async function botAuth(req, env) {
  var u = new URL(req.url), o = u.origin, h = u.host;
  if (botAuthKeyPromise === null) {
    botAuthKeyPromise = loadBotAuthKey(env && env.SITE_CONFIG);
    botAuthKeyPromise.catch(function() {
      botAuthKeyPromise = null;
    });
  }
  var key;
  try {
    key = await botAuthKeyPromise;
  } catch (e) {
    console.error("bot auth key unavailable:", e && e.message);
    return new Response("Service Unavailable", { status: 503, headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Retry-After": "30"
    } });
  }
  var cr = Math.floor(Date.now() / 1e3), ex = cr + 300;
  var si = 'sig1=("@authority" "signature-agent");created=' + cr + ';keyid="' + key.kid + '";alg="ed25519";expires=' + ex + ';tag="web-bot-auth"';
  var sb = '"@authority": ' + h + '\n"signature-agent": "' + o + '"\n"@signature-params": ' + si.slice(si.indexOf("=") + 1);
  var sg = btoa(String.fromCharCode.apply(null, new Uint8Array(await crypto.subtle.sign("Ed25519", key.ck, encoder.encode(sb)))));
  return new Response(key.body, { headers: {
    "Content-Type": "application/http-message-signatures-directory+json",
    "Access-Control-Allow-Origin": "*",
    "Signature-Agent": '"' + o + '"',
    "Signature-Input": si,
    "Signature": "sig1=:" + sg + ":",
    "Cache-Control": "public, max-age=240"
  } });
}
__name(botAuth, "botAuth");
__name2(botAuth, "botAuth");
function agentAuthMetadata(o) {
  return {
    register_uri: o + "/agent/auth",
    identity_types_supported: ["identity_assertion", "anonymous"],
    credential_types_supported: ["client_secret", "private_key_jwt", "signed_http_request"],
    authorization_endpoint: o + "/oauth/authorize",
    token_endpoint: o + "/token",
    revocation_uri: o + "/agent/revoke",
    claim_uri: o + "/agent/claims",
    documentation_uri: o + "/auth.md"
  };
}
__name(agentAuthMetadata, "agentAuthMetadata");
__name2(agentAuthMetadata, "agentAuthMetadata");
function authMd(o) {
  var tb = String.fromCharCode(96, 96, 96);
  return new Response([
    "# auth.md",
    "",
    "You are an agent. This document tells you how to register a credential for hussamfaroug.com.",
    "",
    "## Agent Authentication",
    "",
    tb + "json",
    JSON.stringify({
      agent_auth: agentAuthMetadata(o)
    }, null, 2),
    tb,
    "",
    "",
    "## Step 1 - Register",
    "",
    "POST to the registration endpoint with your desired client metadata:",
    "",
    tb + "http",
    "POST /agent/auth HTTP/1.1",
    "Host: hussamfaroug.com",
    "Content-Type: application/json",
    "",
    JSON.stringify({
      client_name: "My AI Agent",
      redirect_uris: ["https://my-agent.example.com/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    }),
    tb,
    "",
    "",
    "## Step 2 - Authorize",
    "",
    "Open the authorization endpoint in a browser:",
    "",
    tb,
    o + "/oauth/authorize?response_type=code&client_id=agent-1234567890&redirect_uri=https://my-agent.example.com/callback&scope=agent:register&code_challenge=<PKCE_CHALLENGE>&code_challenge_method=S256",
    tb,
    "",
    "",
    "## Step 3 - Exchange code for token",
    "",
    tb + "http",
    "POST /token HTTP/1.1",
    "Host: hussamfaroug.com",
    "Content-Type: application/x-www-form-urlencoded",
    "",
    "grant_type=authorization_code&code=<code>&redirect_uri=https://my-agent.example.com/callback&code_verifier=<PKCE_VERIFIER>",
    tb,
    "",
    "",
    "## Step 4 - Use the token",
    "",
    tb + "http",
    "GET / HTTP/1.1",
    "Host: hussamfaroug.com",
    "Authorization: Bearer <access_token>",
    tb,
    "",
    "",
    "## Endpoints",
    "",
    "- register_uri: " + o + "/agent/auth",
    "- authorization_endpoint: " + o + "/oauth/authorize",
    "- token_endpoint: " + o + "/token",
    "- revocation_uri: " + o + "/agent/revoke",
    "- claim_uri: " + o + "/agent/claims",
    "- jwks_uri: " + o + "/.well-known/http-message-signatures-directory",
    "",
    "Contact: " + C,
    ""
  ].join("\n"), { headers: {
    "Content-Type": "text/markdown",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": PUBLIC_CACHE_CONTROL
  } });
}
__name(authMd, "authMd");
__name2(authMd, "authMd");
function oauthAs(o) {
  return cachedJson({
    issuer: o,
    authorization_endpoint: o + "/oauth/authorize",
    token_endpoint: o + "/token",
    registration_endpoint: o + "/agent/auth",
    revocation_endpoint: o + "/agent/revoke",
    jwks_uri: o + "/.well-known/http-message-signatures-directory",
    scopes_supported: ["read", "write", "agent:register"],
    response_types_supported: ["code", "token"],
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    agent_auth: agentAuthMetadata(o),
    documentation: o + "/auth.md"
  });
}
__name(oauthAs, "oauthAs");
__name2(oauthAs, "oauthAs");
function oauthPr(o) {
  return cachedJson({
    resource: o,
    authorization_servers: [o],
    scopes_supported: ["read", "write", "agent:register"],
    bearer_methods_supported: ["header"],
    resource_documentation: o + "/auth.md",
    jwks_uri: o + "/.well-known/http-message-signatures-directory",
    agent_auth: agentAuthMetadata(o)
  });
}
__name(oauthPr, "oauthPr");
__name2(oauthPr, "oauthPr");
function openid(o) {
  return cachedJson({
    issuer: o,
    authorization_endpoint: o + "/oauth/authorize",
    token_endpoint: o + "/token",
    userinfo_endpoint: o + "/agent/claims",
    jwks_uri: o + "/.well-known/http-message-signatures-directory",
    response_types_supported: ["code", "token", "id_token"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["read", "write", "agent:register"],
    grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    claims_supported: ["sub", "email", "email_verified", "name", "groups"]
  });
}
__name(openid, "openid");
__name2(openid, "openid");
function mcpMetadata(o) {
  return {
    serverInfo: { name: "hussamfaroug.com", version: "1.0.0" },
    transport: { type: "http", url: o + "/.well-known/mcp" },
    capabilities: { tools: true, resources: true, prompts: false },
    tools: [{ name: "get_site_info", description: "Get information about hussamfaroug.com", inputSchema: { type: "object", properties: {} } }]
  };
}
__name(mcpMetadata, "mcpMetadata");
__name2(mcpMetadata, "mcpMetadata");
function ard(o) {
  return cachedJson({
    linkset: [
      { anchor: o, href: o + "/.well-known/mcp/server-card.json", rel: "service-meta", type: "application/vnd.mcp.server+json", title: "HussamFaroug MCP Server", description: "MCP server for hussamfaroug.com" },
      { anchor: o, href: o + "/.well-known/agent-card.json", rel: "agent", type: "application/vnd.a2a.agent+json", title: "HussamFaroug A2A Agent", description: "A2A-compatible AI agent for hussamfaroug.com" },
      { anchor: o, href: o + "/.well-known/oauth-authorization-server", rel: "service-desc", type: "application/json", title: "OAuth Authorization Server", description: "OAuth authorization server metadata" },
      { anchor: o, href: o + "/auth.md", rel: "service-doc", type: "text/markdown", title: "Agent Auth Documentation", description: "How to register a credential for hussamfaroug.com" },
      { anchor: o, href: o + "/.well-known/health", rel: "status", type: "application/json", title: "Health Check", description: "Service health endpoint" }
    ]
  }, { contentType: "application/linkset+json" });
}
__name(ard, "ard");
__name2(ard, "ard");
function aiCatalog(o) {
  return cachedJson({
    specVersion: "0.1.0",
    host: { name: "hussamfaroug.com", description: "Personal website for Hussam Faroug - AI agent-ready", url: o },
    entries: [
      { identifier: "urn:air:hussamfaroug.com:mcp:server", displayName: "HussamFaroug MCP Server", type: "application/vnd.mcp.server+json", url: o + "/.well-known/mcp/server-card.json", description: "MCP server for hussamfaroug.com", representativeQueries: ["what tools does the hussamfaroug MCP server expose", "how do I connect to the hussamfaroug MCP server", "what is the MCP server card for hussamfaroug.com"] },
      { identifier: "urn:air:hussamfaroug.com:a2a:agent", displayName: "HussamFaroug A2A Agent", type: "application/vnd.a2a.agent+json", url: o + "/.well-known/agent-card.json", description: "A2A-compatible AI agent for hussamfaroug.com", representativeQueries: ["what is the agent card for hussamfaroug.com", "how do I interact with the hussamfaroug agent"] },
      { identifier: "urn:air:hussamfaroug.com:auth", displayName: "HussamFaroug Auth", type: "application/json", url: o + "/.well-known/oauth-authorization-server", description: "OAuth authorization server metadata for hussamfaroug.com", representativeQueries: ["how do I authenticate with hussamfaroug.com", "what OAuth endpoints does hussamfaroug.com support"] }
    ]
  });
}
__name(aiCatalog, "aiCatalog");
__name2(aiCatalog, "aiCatalog");
function agentSkillsIndex(o) {
  return cachedJson({
    $schema: "https://agentskills.io/schemas/agent-skills-index.v0.2.json",
    skills: [
      { name: "get_site_info", type: "tool", description: "Get information about hussamfaroug.com", url: o + "/.well-known/agent-skills/get_site_info/SKILL.md" },
      { name: "agent_auth", type: "skill", description: "Register a credential for hussamfaroug.com", url: o + "/auth.md" }
    ]
  });
}
__name(agentSkillsIndex, "agentSkillsIndex");
__name2(agentSkillsIndex, "agentSkillsIndex");
function healthCheck() {
  return cachedJson({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() }, { cacheControl: "no-store" });
}
__name(healthCheck, "healthCheck");
__name2(healthCheck, "healthCheck");
function agentCard(o) {
  return cachedJson({
    schemaVersion: "1.0",
    name: "HussamFaroug Agent",
    version: "1.0.0",
    description: "AI agent for hussamfaroug.com providing API access, content retrieval, and agent-to-agent communication.",
    url: o + "/a2a",
    protocolVersion: "1.0",
    preferredTransport: "jsonrpc",
    supportedInterfaces: [{
      protocol: "jsonrpc",
      version: "2.0",
      url: o + "/a2a",
      transport: "http",
      streaming: true,
      pushNotifications: true
    }],
    capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
    skills: [
      { id: "api-query", name: "API Query", description: "Query the hussamfaroug.com API catalog" },
      { id: "content-retrieval", name: "Content Retrieval", description: "Retrieve content from hussamfaroug.com" },
      { id: "agent-handoff", name: "Agent Handoff", description: "Delegate tasks via A2A protocol" },
      { id: "mcp-tools", name: "MCP Tools", description: "Access MCP server tools" }
    ],
    authentication: {
      type: "oauth",
      authorizationServer: o + "/.well-known/oauth-authorization-server",
      protectedResourceMetadata: o + "/.well-known/oauth-protected-resource",
      documentation: o + "/auth.md"
    },
    links: {
      apiCatalog: o + "/.well-known/api-catalog",
      mcpServerCard: o + "/.well-known/mcp/server-card.json",
      authMd: o + "/auth.md"
    }
  }, { cacheControl: "no-store" });
}
__name(agentCard, "agentCard");
__name2(agentCard, "agentCard");
function secHdrs(h, n) {
  h.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-" + n + "' https://challenges.cloudflare.com ; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests");
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  h.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.delete("X-XSS-Protection");
  h.delete("Expect-CT");
  return h;
}
__name(secHdrs, "secHdrs");
__name2(secHdrs, "secHdrs");
function varyAccept(h) {
  var vary = h.get("Vary");
  if (!vary) {
    h.set("Vary", "Accept");
  } else if (vary.trim() !== "*" && !vary.split(",").some(function(value) { return value.trim().toLowerCase() === "accept"; })) {
    h.set("Vary", vary + ", Accept");
  }
  return h;
}
__name(varyAccept, "varyAccept");
__name2(varyAccept, "varyAccept");
function webmcp(n) {
  return '<script nonce="' + n + '">(function(){if(navigator.modelContext&&navigator.modelContext.provideContext){navigator.modelContext.provideContext({tools:[{name:"get_site_info",description:"Get information about hussamfaroug.com",inputSchema:{type:"object",properties:{}},execute:async function(){return{name:"hussamfaroug.com",url:location.origin};}}]});}})();<\/script>';
}
__name(webmcp, "webmcp");
__name2(webmcp, "webmcp");
function linkHdr(o) {
  return "<" + o + '/.well-known/api-catalog>; rel="api-catalog", <' + o + '/.well-known/agent-card.json>; rel="agent", <' + o + '/.well-known/mcp/server-card.json>; rel="service-meta", <' + o + '/.well-known/oauth-authorization-server>; rel="service-desc", <' + o + '/.well-known/oauth-protected-resource>; rel="service-desc", <' + o + '/auth.md>; rel="service-doc"';
}
__name(linkHdr, "linkHdr");
__name2(linkHdr, "linkHdr");
async function wellKnown(req, env) {
  var u = new URL(req.url);
  var o = u.origin;
  var p = u.pathname.replace(/^\/\.well-known\//, "");
  if (p === "http-message-signatures-directory") return await botAuth(req, env);
  if (p === "health") return healthCheck();
  if (p === "oauth-authorization-server") return oauthAs(o);
  if (p === "oauth-protected-resource") return oauthPr(o);
  if (p === "openid-configuration") return openid(o);
  if (p === "api-catalog") return ard(o);
  if (p === "ai-catalog.json") return aiCatalog(o);
  if (p === "agent-skills/index.json") return agentSkillsIndex(o);
  if (p === "agent-card.json") return agentCard(o);
  if (p === "mcp.json" || p === "mcp/server-card.json") return cachedJson(mcpMetadata(o));
  return null;
}
__name(wellKnown, "wellKnown");
__name2(wellKnown, "wellKnown");
function mdDec(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, function(m, c) {
    var codePoint = Number(c);
    return codePoint <= 1114111 ? String.fromCodePoint(codePoint) : m;
  }).replace(/&amp;/g, "&");
}
__name(mdDec, "mdDec");
__name2(mdDec, "mdDec");
function mdStripTags(h) {
  var text = "";
  var i = 0;
  while (i < h.length) {
    if (h[i] !== "<") {
      text += h[i++];
      continue;
    }
    if (h.startsWith("<!--", i)) {
      var commentEnd = h.indexOf("-->", i + 4);
      if (commentEnd !== -1) {
        i = commentEnd + 3;
        continue;
      }
    }
    var nameStart = h[i + 1] === "/" ? i + 2 : i + 1;
    var firstChar = h.charCodeAt(nameStart);
    if (!(firstChar >= 65 && firstChar <= 90 || firstChar >= 97 && firstChar <= 122)) {
      text += h[i++];
      continue;
    }
    var quote = "";
    var end = nameStart + 1;
    while (end < h.length) {
      var char = h[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      end++;
    }
    if (end === h.length) {
      text += h.slice(i);
      break;
    }
    i = end + 1;
  }
  return text;
}
__name(mdStripTags, "mdStripTags");
__name2(mdStripTags, "mdStripTags");
function mdClean(h) {
  return mdStripTags(h).replace(/\s+/g, " ").trim();
}
__name(mdClean, "mdClean");
__name2(mdClean, "mdClean");
function mdRu(h, b) {
  try {
    return new URL(h, b).href;
  } catch {
    return h;
  }
}
__name(mdRu, "mdRu");
__name2(mdRu, "mdRu");
async function convertMd(html, url) {
  var tagAttrs = "(?:[^>\"']|\"[^\"]*\"|'[^']*')*";
  var t = (html.match(new RegExp("<title\\b" + tagAttrs + ">([\\s\\S]*?)<\\/title\\s*>", "i")) || [])[1] || "";
  t = mdDec(t.trim());
  var b = await new HTMLRewriter()
    .on("script, style, head, header, nav, footer, aside, svg, meta, link", {
      element(el) {
        // Keep a text boundary so removal cannot reconstruct a tag.
        el.replace(" ");
      }
    })
    .onDocument({
      comments(comment) {
        comment.replace(" ");
      }
    })
    .transform(new Response(html)).text();
  var m = b.match(new RegExp("<(main|article)\\b" + tagAttrs + ">([\\s\\S]*?)<\\/\\1\\s*>", "i"));
  if (m) b = m[2];
  else {
    m = b.match(new RegExp("<body\\b" + tagAttrs + ">([\\s\\S]*?)<\\/body\\s*>", "i"));
    if (m) b = m[1];
  }
  var md = "";
  if (t) md += "# " + t + "\n\n";
  b = b.replace(new RegExp("<h([1-6])\\b" + tagAttrs + ">([\\s\\S]*?)<\\/h\\1\\s*>", "gi"), function(_, level, content) {
    return "\n\n" + "#".repeat(Number(level)) + " " + mdClean(content) + "\n\n";
  });
  b = b.replace(new RegExp("<pre\\b" + tagAttrs + ">([\\s\\S]*?)<\\/pre\\s*>", "gi"), function(_, c) {
    return "\n\n```\n" + mdStripTags(c).trim() + "\n```\n\n";
  });
  b = b.replace(new RegExp("<code\\b" + tagAttrs + ">([\\s\\S]*?)<\\/code\\s*>", "gi"), function(_, c) {
    return "`" + mdStripTags(c).trim() + "`";
  });
  b = b.replace(new RegExp("<blockquote\\b" + tagAttrs + ">([\\s\\S]*?)<\\/blockquote\\s*>", "gi"), function(_, c) {
    return "\n\n" + mdClean(c).split("\n").map(function(l) {
      return "> " + l;
    }).join("\n") + "\n\n";
  });
  b = b.replace(new RegExp("<img\\b" + tagAttrs + ">", "gi"), function(m2) {
    var a = (m2.match(/alt=["']([^"']*)["']/i) || [])[1] || "";
    var s = (m2.match(/src=["']([^"']*)["']/i) || [])[1] || "";
    return "![" + a + "](" + mdRu(s, url) + ")";
  });
  b = b.replace(new RegExp("<a\\b" + tagAttrs + "\\bhref\\s*=\\s*([\"'])(.*?)\\1" + tagAttrs + ">([\\s\\S]*?)<\\/a\\s*>", "gi"), function(_, quote, h, c) {
    return "[" + mdClean(c) + "](" + mdRu(h, url) + ")";
  });
  b = b.replace(new RegExp("<(ul|ol)\\b" + tagAttrs + ">([\\s\\S]*?)<\\/\\1\\s*>", "gi"), function(_, type, c) {
    var it = c.match(new RegExp("<li\\b" + tagAttrs + ">([\\s\\S]*?)<\\/li\\s*>", "gi")) || [];
    var ordered = type.toLowerCase() === "ol";
    return "\n\n" + it.map(function(x, i2) {
      return (ordered ? i2 + 1 + ". " : "- ") + mdClean(x);
    }).join("\n") + "\n\n";
  });
  b = b.replace(new RegExp("<(strong|b|em|i)\\b" + tagAttrs + ">([\\s\\S]*?)<\\/\\1\\s*>|<hr\\b" + tagAttrs + "\\s*\\/?>|<p\\b" + tagAttrs + ">|<\\/p\\s*>|<br\\b" + tagAttrs + "\\s*\\/?>", "gi"), function(match, tag, content) {
    if (content !== void 0) {
      var text = mdClean(content);
      return tag.toLowerCase() === "strong" || tag.toLowerCase() === "b" ? "**" + text + "**" : "*" + text + "*";
    }
    if (/^<hr/i.test(match)) return "\n\n---\n\n";
    if (/^<p/i.test(match)) return "\n\n";
    if (/^<\/p/i.test(match)) return "\n";
    return "\n";
  });
  b = mdStripTags(b);
  b = mdDec(b);
  b = b.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/^[ \t]+/gm, "").replace(/[ \t]+$/gm, "").trim();
  return (md + b).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(convertMd, "convertMd");
__name2(convertMd, "convertMd");
var worker_default = {
  async fetch(request, env) {
    if (request.method === "HEAD") {
      var getRequest = new Request(request, { method: "GET" });
      var response = await handleRequest(getRequest, env);
      if (response.body) await response.body.cancel();
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return handleRequest(request, env);
  },
  async scheduled(event, env) {
    return handleScheduled(event, env);
  }
};
async function handleScheduled(event, env) {
  var pages = ["/", "/index.html", "/Privacy.html"];
  var origin = "https://hgzvt98gtk-svg-github-io.pages.dev";
  for (var i = 0; i < pages.length; i++) {
    try {
      var u = origin + pages[i];
      var r = await fetch(u, { method: "GET", headers: { "User-Agent": "cache-warmer/1.0" }, cf: { cacheTtl: 3600 } });
      console.log("cache warmed:", pages[i], r.status);
    } catch (e) {
      console.error("cache warm failed:", pages[i], e && e.message);
    }
  }
}

async function handleRequest(req, env) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400"
    } });
  }
  var u = new URL(req.url);
  var o = u.origin;
  var isMaintenance = false;
  try {
    isMaintenance = await env.FLAGS?.getBooleanValue("maintenance-mode", false);
  } catch (e) {
  }
  if (isMaintenance) {
    return new Response("Site under maintenance", { status: 503, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "Retry-After": "3600" } });
  }
  if (u.pathname.startsWith("/.well-known/")) {
    var wkResp = await wellKnown(req, env);
    if (wkResp) return wkResp;
  }
  if (u.pathname === "/auth.md") {
    return authMd(o);
  }
  if (u.pathname === "/robots.txt") {
    return new Response("User-agent: *\nAllow: /\nDisallow: /api/\n\n# Content-Signal\nCS: hussamfaroug.com\n\n# Agentmap\nAgentmap: " + o + "/.well-known/api-catalog\n", { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=3600" } });
  }
  var accept = req.headers.get("Accept") || "";
  var pu = O + u.pathname + u.search;
  var fh = new Headers(req.headers);
  ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"].forEach(function(k) { fh.delete(k); });
  var r;
  try {
    r = await fetch(pu, { method: req.method, headers: fh, redirect: "manual" });
  } catch (e) {
    console.error("origin fetch failed:", e && e.message, pu);
    return new Response("Origin unavailable", { status: 502, headers: {
      "Content-Type": "text/plain",
      "Retry-After": "30",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    } });
  }
  var ct = r.headers.get("Content-Type") || "";
  if (ct.indexOf("text/html") === -1 || r.body === null) {
    var passthroughHeaders = new Headers(r.headers);
    if (req.method === "HEAD" && ct.indexOf("text/html") !== -1) varyAccept(passthroughHeaders);
    return new Response(r.body, { status: r.status, headers: passthroughHeaders });
  }
  if (accept.indexOf("text/markdown") !== -1) {
    var htmlText = await r.text();
    var md = await convertMd(htmlText, pu);
    var tokens = Math.max(1, Math.ceil(encoder.encode(md).length / 4));
    return new Response(md, { headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "x-markdown-tokens": String(tokens),
      "Vary": "Accept",
      "Content-Signal": "ai-train=yes, search=yes, ai-input=yes",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    } });
  }
  var nonceBytes = crypto.getRandomValues(new Uint8Array(24));
  var n = b64u(nonceBytes);
  var ws = webmcp(n);
  var transformed = new HTMLRewriter()
    .on("script[src]", {
      element(el) {
        var src = el.getAttribute("src");
        if (src && /\.webmcp\/bridge\.js/i.test(src)) el.remove();
      }
    })
    .on("head", {
      element(el) {
        el.append('<link rel="service-meta" href="' + o + '/.well-known/mcp/server-card.json" />', { html: true });
        el.append('<link rel="agent" href="' + o + '/.well-known/agent-card.json" />', { html: true });
        el.append('<link rel="service-desc" href="' + o + '/.well-known/oauth-authorization-server" />', { html: true });
        el.append('<link rel="service-doc" href="' + o + '/auth.md" />', { html: true });
      }
    })
    .on("body", {
      element(el) {
        el.append(ws, { html: true });
      }
    })
    .transform(r);
  var reader = transformed.body.getReader();
  var body = new ReadableStream({
    async pull(controller) {
      try {
        var chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  var respHeaders = new Headers(transformed.headers);
  secHdrs(respHeaders, n);
  respHeaders.set("Link", linkHdr(o));
  respHeaders.delete("Content-Length");
  varyAccept(respHeaders);
  return new Response(body, { status: transformed.status, headers: respHeaders });
}
export { worker_default as default };
