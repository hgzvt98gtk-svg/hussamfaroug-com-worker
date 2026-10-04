import { botAuth } from "./bot-auth.js";
import { authMd, isLegacyDiscoveryPath, wellKnown } from "./metadata.js";
import { convertMd } from "./markdown.js";
import { b64u, discoveryHtml, linkHdr, secHdrs, varyAccept, webmcp } from "./response.js";
import { fetchOriginWithRetry, prefersMarkdown, readHtml } from "./proxy.js";
import { checkRateLimit } from "./rate-limit.js";
import { recordConversionTime, recordError, recordRequest, recordTiming, TIMING_SAMPLE_RATE } from "./metrics.js";

var encoder = new TextEncoder();

function applyCachePolicy(headers, request, upstream, markdown = false) {
  var identityHeaders = ["authorization", "cookie", "x-api-key", "x-auth-token", "x-access-token", "bearer", "x-custom-auth"];
  if (identityHeaders.some(header => request.headers.has(header)) || upstream.headers.has("Set-Cookie")) {
    headers.set("Cache-Control", "private, no-store");
    for (var header of ["CDN-Cache-Control", "Cloudflare-CDN-Cache-Control", "Surrogate-Control"]) {
      if (headers.has(header)) headers.set(header, "private, no-store");
    }
  } else if (markdown && !headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
}

var worker_default = {
  async fetch(request, env) {
    if (request.method === "HEAD") {
      var getRequest = new Request(request, { method: "GET" });
      var response = await handleRequest(getRequest, env, true);
      if (response.body) await response.body.cancel();
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return handleRequest(request, env);
  }
};

async function handleRequest(request, env, headOnly = false) {
  var sampleTiming = Math.random() < TIMING_SAMPLE_RATE;
  recordRequest(request.method === "GET" || request.method === "HEAD"
    ? (prefersMarkdown(request.headers.get("Accept") || "") ? "markdown" : "html")
    : "other");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400"
    } });
  }
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: {
      Allow: "GET, HEAD, OPTIONS", "Cache-Control": "no-store"
    } });
  }
  var clientId = request.headers.get("cf-connecting-ip") || "unknown";
  if (!checkRateLimit(clientId)) {
    recordError("rateLimit");
    return new Response("Rate limit exceeded", { status: 429, headers: {
      "Content-Type": "text/plain",
      "Retry-After": "60",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    } });
  }
  var url = new URL(request.url);
  var origin = url.origin;
  if (url.pathname.startsWith("/.well-known/") || isLegacyDiscoveryPath(url.pathname)) {
    var metadataResponse = await wellKnown(request, () => botAuth(request, env));
    if (metadataResponse) return metadataResponse;
  }
  if (url.pathname === "/auth.md") return authMd(origin);
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nAllow: /\nDisallow: /api/\n\n# Content-Signal\nCS: hussamfaroug.com\n\n# Agentmap\nAgentmap: " + origin + "/.well-known/api-catalog\n", {
      headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=3600" }
    });
  }
  var proxyOrigin = env.ORIGIN;
  if (!proxyOrigin) {
    recordError("configuration");
    return new Response("Origin configuration unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  var proxyUrl;
  try {
    proxyUrl = new URL(proxyOrigin);
    if (!["https:", "http:"].includes(proxyUrl.protocol) || proxyUrl.username || proxyUrl.password || proxyUrl.origin === origin) throw new Error("Invalid origin");
    var trustedOrigin = proxyUrl.origin;
    proxyUrl.pathname = url.pathname;
    proxyUrl.search = url.search;
    proxyUrl.hash = "";
    if (proxyUrl.origin !== trustedOrigin) throw new Error("Invalid destination");
  } catch {
    recordError("configuration");
    return new Response("Origin configuration unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  var forwardedHeaders = new Headers(request.headers);
  var connectionHeaders = (forwardedHeaders.get("Connection") || "").split(",").map(header => header.trim()).filter(Boolean);
  [...connectionHeaders, "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
    "host", "cookie", "authorization", "proxy-authorization", "forwarded", "x-forwarded-host", "x-forwarded-proto",
    "x-forwarded-for", "x-real-ip", "x-client-ip", "client-ip", "x-cluster-client-ip", "true-client-ip",
    "cf-connecting-ip", "cf-connecting-ipv6", "cf-pseudo-ipv4", "fastly-client-ip",
    "if-none-match", "if-modified-since", "range", "if-range"].forEach(function(header) {
    forwardedHeaders.delete(header);
  });
  forwardedHeaders.set("Accept", "text/html, */*;q=0.8");
  var upstream;
  var originStartedAt = sampleTiming ? performance.now() : 0;
  try {
    upstream = await fetchOriginWithRetry(proxyUrl.href, forwardedHeaders, request.signal, 1);
  } catch {
    console.error("origin fetch failed");
    return new Response("Origin unavailable", { status: 502, headers: {
      "Content-Type": "text/plain",
      "Retry-After": "30",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    } });
  } finally {
    if (sampleTiming) recordTiming("origin", performance.now() - originStartedAt);
  }
  if (upstream.status >= 500) recordError("origin");
  var mediaType = (upstream.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "text/html" || upstream.body === null) {
    var headersStartedAt = sampleTiming ? performance.now() : 0;
    var passthroughHeaders = new Headers(upstream.headers);
    applyCachePolicy(passthroughHeaders, request, upstream);
    if (sampleTiming) recordTiming("headers", performance.now() - headersStartedAt);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: passthroughHeaders });
  }
  if (prefersMarkdown(request.headers.get("Accept") || "")) {
    var markdown = null;
    if (headOnly) {
      await upstream.body.cancel().catch(() => {});
    } else {
      try {
        var readStartedAt = sampleTiming ? performance.now() : 0;
        var html;
        try {
          html = await readHtml(upstream);
        } finally {
          if (sampleTiming) recordTiming("readHtml", performance.now() - readStartedAt);
        }
        var conversionStartedAt = performance.now();
        try {
          markdown = await convertMd(html, proxyUrl.href);
        } finally {
          var conversionMs = performance.now() - conversionStartedAt;
          recordConversionTime(conversionMs);
          if (sampleTiming) recordTiming("conversion", conversionMs);
        }
      } catch {
        recordError("conversion");
        console.error("origin conversion failed");
        return new Response("Origin conversion unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
      }
    }
    var tokens;
    if (markdown !== null) {
      var tokenStartedAt = sampleTiming ? performance.now() : 0;
      tokens = String(Math.max(1, Math.ceil(encoder.encode(markdown).length / 4)));
      if (sampleTiming) recordTiming("tokens", performance.now() - tokenStartedAt);
    }
    headersStartedAt = sampleTiming ? performance.now() : 0;
    var markdownHeaders = new Headers(upstream.headers);
    ["Content-Length", "Content-Encoding", "ETag", "Content-MD5", "Digest", "Content-Digest", "Repr-Digest", "Accept-Ranges", "Content-Range"].forEach(header => markdownHeaders.delete(header));
    markdownHeaders.set("Content-Type", "text/markdown; charset=utf-8");
    if (tokens !== undefined) markdownHeaders.set("x-markdown-tokens", tokens);
    markdownHeaders.set("Content-Signal", "ai-train=yes, search=yes, ai-input=yes");
    applyCachePolicy(markdownHeaders, request, upstream, true);
    varyAccept(markdownHeaders);
    if (sampleTiming) recordTiming("headers", performance.now() - headersStartedAt);
    return new Response(markdown, { status: upstream.status, statusText: upstream.statusText, headers: markdownHeaders });
  }
  var nonce = b64u(crypto.getRandomValues(new Uint8Array(24)));
  var script = webmcp(nonce);
  var transformed = new HTMLRewriter()
    .on("script[src]", {
      element(el) {
        var src = el.getAttribute("src");
        if (src && /\.webmcp\/bridge\.js/i.test(src)) el.remove();
      }
    })
    .on("head", {
      element(el) {
        el.append(discoveryHtml(origin), { html: true });
      }
    })
    .on("body", {
      element(el) {
        el.append(script, { html: true });
      }
    })
    .transform(upstream);
  headersStartedAt = sampleTiming ? performance.now() : 0;
  var responseHeaders = new Headers(transformed.headers);
  applyCachePolicy(responseHeaders, request, upstream);
  secHdrs(responseHeaders, nonce);
  responseHeaders.set("Link", linkHdr(origin));
  ["Content-Length", "Content-Encoding", "ETag", "Content-MD5", "Digest", "Content-Digest", "Repr-Digest"].forEach(header => responseHeaders.delete(header));
  varyAccept(responseHeaders);
  if (sampleTiming) recordTiming("headers", performance.now() - headersStartedAt);
  return new Response(transformed.body, { status: transformed.status, headers: responseHeaders });
}

export { worker_default as default };
