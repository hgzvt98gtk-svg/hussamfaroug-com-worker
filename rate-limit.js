// Per-isolate, best-effort rate limiting keyed by Cloudflare's client IP header.
// State is not shared across isolates or locations; the tracker is bounded so a
// flood of distinct IPs cannot exhaust memory.
import {
  RATE_LIMIT_MAX_CLIENTS,
  RATE_LIMIT_REQUESTS_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS
} from "./constants.js";

export { RATE_LIMIT_MAX_CLIENTS, RATE_LIMIT_WINDOW_MS };
export const RATE_LIMIT_REQUESTS = RATE_LIMIT_REQUESTS_PER_MINUTE;
const rateLimitTracker = new Map();

export function checkRateLimit(clientId, now = Date.now()) {
  const entry = rateLimitTracker.get(clientId);
  if (!entry || now > entry.resetTime) {
    if (!entry && rateLimitTracker.size >= RATE_LIMIT_MAX_CLIENTS) {
      rateLimitTracker.delete(rateLimitTracker.keys().next().value);
    }
    rateLimitTracker.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count < RATE_LIMIT_REQUESTS) {
    entry.count++;
    return true;
  }
  return false;
}

export function resetRateLimits() {
  rateLimitTracker.clear();
}
