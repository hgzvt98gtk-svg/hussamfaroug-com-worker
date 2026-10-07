import { recordError, recordRetrySuccess } from "./metrics.js";
import { MAX_HTML_BYTES, ORIGIN_RETRY_BASE_DELAY_MS, ORIGIN_TIMEOUT_MS } from "./constants.js";

export { MAX_HTML_BYTES, ORIGIN_RETRY_BASE_DELAY_MS, ORIGIN_TIMEOUT_MS };

export function prefersMarkdown(accept) {
  const ranges = accept.toLowerCase().split(",").map(part => {
    const [type, ...params] = part.trim().split(";");
    const quality = params.find(param => param.trim().startsWith("q="));
    const value = quality ? quality.trim().slice(2) : "1";
    return { type: type.trim(), q: /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0 };
  });
  function score(type) {
    for (const candidate of [type, "text/*", "*/*"]) {
      const matches = ranges.filter(range => range.type === candidate);
      if (matches.length) return Math.max(...matches.map(range => range.q));
    }
    return 0;
  }
  return ranges.some(range => range.type === "text/markdown" && range.q > 0) &&
    score("text/markdown") >= score("text/html");
}

export async function fetchOrigin(url, headers, requestSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  requestSignal.addEventListener("abort", abort, { once: true });
  if (requestSignal.aborted) abort();
  const timer = setTimeout(abort, ORIGIN_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(timer);
    requestSignal.removeEventListener("abort", abort);
  };
  try {
    const response = await fetch(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    return new Response(new ReadableStream({
      async pull(stream) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            cleanup();
            stream.close();
          } else {
            stream.enqueue(chunk.value);
          }
        } catch (error) {
          cleanup();
          stream.error(error);
        }
      },
      async cancel(reason) {
        cleanup();
        controller.abort();
        await reader.cancel(reason);
      }
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    cleanup();
    throw error;
  }
}

function waitForRetry(delayMs, requestSignal) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    requestSignal.addEventListener("abort", done, { once: true });
  });
}

// Retries transient origin fetch failures (network errors and timeouts, not HTTP
// error statuses) with exponential backoff: 100ms, 200ms, ... Client cancellation
// stops further attempts. Errors are rethrown unchanged and never logged here, so
// origin details and request URLs do not reach the logs.
export async function fetchOriginWithRetry(url, headers, requestSignal, maxRetries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchOrigin(url, headers, requestSignal);
      if (attempt > 0) recordRetrySuccess();
      return response;
    } catch (error) {
      if (attempt >= maxRetries) {
        recordError("retry");
        throw error;
      }
      if (requestSignal.aborted) throw error;
      const delayMs = Math.pow(2, attempt) * ORIGIN_RETRY_BASE_DELAY_MS;
      console.log("origin fetch retry " + (attempt + 1) + "/" + maxRetries + " after " + delayMs + "ms");
      await waitForRetry(delayMs, requestSignal);
      if (requestSignal.aborted) throw error;
    }
  }
}

export async function readHtml(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return html + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Error("HTML conversion limit exceeded");
      html += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
