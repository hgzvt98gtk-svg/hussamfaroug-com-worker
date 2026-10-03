import { botAuth } from "./bot-auth.js";
import { authMd, wellKnown } from "./metadata.js";
import { convertMd } from "./markdown.js";
import { linkHdr, secHdrs, varyAccept, webmcp } from "./response.js";

var encoder = new TextEncoder();

function b64u(bytes) {
  var binary = "";
  for (var i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
  var url = new URL(request.url);
  var origin = url.origin;
  if (url.pathname.startsWith("/.well-known/")) {
    var metadataResponse = await wellKnown(request, () => botAuth(request, env));
    if (metadataResponse) return metadataResponse;
  }
  if (url.pathname === "/auth.md") return authMd(origin);
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nAllow: /\nDisallow: /api/\n\n# Content-Signal\nCS: hussamfaroug.com\n\n# Agentmap\nAgentmap: " + origin + "/.well-known/api-catalog\n", {
      headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=3600" }
    });
  }
  var accept = request.headers.get("Accept") || "";
  var proxyOrigin = env.ORIGIN;
  if (!proxyOrigin) return new Response("Origin configuration unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  var proxyUrl = new URL(url.pathname + url.search, proxyOrigin);
  var forwardedHeaders = new Headers(request.headers);
  ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"].forEach(function(header) {
    forwardedHeaders.delete(header);
  });
  var upstream;
  try {
    upstream = await fetch(proxyUrl.href, { method: request.method, headers: forwardedHeaders, redirect: "manual" });
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
    if (request.method === "HEAD" && contentType.indexOf("text/html") !== -1) varyAccept(passthroughHeaders);
    return new Response(upstream.body, { status: upstream.status, headers: passthroughHeaders });
  }
  if (accept.indexOf("text/markdown") !== -1) {
    var html = await upstream.text();
    var markdown = await convertMd(html, proxyUrl.href);
    var tokens = Math.max(1, Math.ceil(encoder.encode(markdown).length / 4));
    return new Response(markdown, { headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "x-markdown-tokens": String(tokens),
      "Vary": "Accept",
      "Content-Signal": "ai-train=yes, search=yes, ai-input=yes",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    } });
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
        el.append('<link rel="service-meta" href="' + origin + '/.well-known/mcp/server-card.json" />', { html: true });
        el.append('<link rel="agent" href="' + origin + '/.well-known/agent-card.json" />', { html: true });
        el.append('<link rel="service-desc" href="' + origin + '/.well-known/oauth-authorization-server" />', { html: true });
        el.append('<link rel="service-doc" href="' + origin + '/auth.md" />', { html: true });
      }
    })
    .on("body", {
      element(el) {
        el.append(script, { html: true });
      }
    })
    .transform(upstream);
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
  var responseHeaders = new Headers(transformed.headers);
  secHdrs(responseHeaders, nonce);
  responseHeaders.set("Link", linkHdr(origin));
  responseHeaders.delete("Content-Length");
  varyAccept(responseHeaders);
  return new Response(body, { status: transformed.status, headers: responseHeaders });
}

export { worker_default as default, handleRequest };
