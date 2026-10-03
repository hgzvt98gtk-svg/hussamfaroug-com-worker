import { botAuth } from "./bot-auth.js";
import { authMd, isLegacyDiscoveryPath, wellKnown } from "./metadata.js";
import { convertMd } from "./markdown.js";
import { b64u, discoveryHtml, linkHdr, secHdrs, varyAccept, webmcp } from "./response.js";
import { fetchOrigin, prefersMarkdown, readHtml } from "./proxy.js";

var encoder = new TextEncoder();

var worker_default = {
  async fetch(request, env) {
    if (request.method === "HEAD") {
      var getRequest = new Request(request, { method: "GET" });
      var response = await handleRequest(getRequest, env);
      if (response.body) await response.body.cancel();
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return handleRequest(request, env);
  }
};

async function handleRequest(request, env) {
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
  if (!proxyOrigin) return new Response("Origin configuration unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
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
    return new Response("Origin configuration unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  var forwardedHeaders = new Headers(request.headers);
  var connectionHeaders = (forwardedHeaders.get("Connection") || "").split(",").map(header => header.trim()).filter(Boolean);
  [...connectionHeaders, "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
    "host", "cookie", "authorization", "proxy-authorization", "forwarded", "x-forwarded-host", "x-forwarded-proto",
    "if-none-match", "if-modified-since", "range", "if-range"].forEach(function(header) {
    forwardedHeaders.delete(header);
  });
  forwardedHeaders.set("Accept", "text/html, */*;q=0.8");
  var upstream;
  try {
    upstream = await fetchOrigin(proxyUrl.href, forwardedHeaders, request.signal);
  } catch {
    console.error("origin fetch failed");
    return new Response("Origin unavailable", { status: 502, headers: {
      "Content-Type": "text/plain",
      "Retry-After": "30",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    } });
  }
  var contentType = upstream.headers.get("Content-Type") || "";
  if (contentType.indexOf("text/html") === -1 || upstream.body === null) {
    var passthroughHeaders = new Headers(upstream.headers);
    return new Response(upstream.body, { status: upstream.status, headers: passthroughHeaders });
  }
  if (prefersMarkdown(request.headers.get("Accept") || "")) {
    var markdown;
    try {
      var html = await readHtml(upstream);
      markdown = await convertMd(html, proxyUrl.href);
    } catch {
      console.error("origin conversion failed");
      return new Response("Origin conversion unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    var tokens = Math.max(1, Math.ceil(encoder.encode(markdown).length / 4));
    var markdownHeaders = new Headers(upstream.headers);
    ["Content-Length", "Content-Encoding", "ETag", "Content-MD5", "Digest", "Content-Digest", "Repr-Digest", "Accept-Ranges", "Content-Range"].forEach(header => markdownHeaders.delete(header));
    markdownHeaders.set("Content-Type", "text/markdown; charset=utf-8");
    markdownHeaders.set("x-markdown-tokens", String(tokens));
    markdownHeaders.set("Content-Signal", "ai-train=yes, search=yes, ai-input=yes");
    if (request.headers.has("Authorization") || request.headers.has("Cookie") || upstream.headers.has("Set-Cookie")) {
      markdownHeaders.set("Cache-Control", "private, no-store");
    } else if (!markdownHeaders.has("Cache-Control")) {
      markdownHeaders.set("Cache-Control", "no-store");
    }
    varyAccept(markdownHeaders);
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
  var responseHeaders = new Headers(transformed.headers);
  secHdrs(responseHeaders, nonce);
  responseHeaders.set("Link", linkHdr(origin));
  ["Content-Length", "Content-Encoding", "ETag", "Content-MD5", "Digest", "Content-Digest", "Repr-Digest"].forEach(header => responseHeaders.delete(header));
  varyAccept(responseHeaders);
  return new Response(transformed.body, { status: transformed.status, headers: responseHeaders });
}

export { worker_default as default };
