// Per-isolate, best-effort rate limiting keyed by Cloudflare's client IP header.
// State is not shared across isolates or locations; expired entries are pruned and
// the tracker is bounded so a flood of distinct IPs cannot exhaust memory.
export const RATE_LIMIT_REQUESTS = 100;
export const RATE_LIMIT_WINDOW_MS = 60000;
export const RATE_LIMIT_MAX_CLIENTS = 10000;
const rateLimitTracker = new Map();

export function checkRateLimit(clientId, now = Date.now()) {
  const entry = rateLimitTracker.get(clientId);
  if (!entry || now > entry.resetTime) {
    if (!entry && rateLimitTracker.size >= RATE_LIMIT_MAX_CLIENTS) pruneRateLimits(now);
    rateLimitTracker.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count < RATE_LIMIT_REQUESTS) {
    entry.count++;
    return true;
  }
  return false;
}

function pruneRateLimits(now) {
  for (const [clientId, entry] of rateLimitTracker) {
    if (now > entry.resetTime) rateLimitTracker.delete(clientId);
  }
  // Still full: evict the oldest-inserted client.
  if (rateLimitTracker.size >= RATE_LIMIT_MAX_CLIENTS) rateLimitTracker.delete(rateLimitTracker.keys().next().value);
}

export function resetRateLimits() {
  rateLimitTracker.clear();
}
