// Sliding-window limits kept in this server instance's memory. On Vercel each instance has its own
// counts, so these slow down one caller but are not a global guarantee. The Anthropic workspace
// spend cap is the hard ceiling on model cost.

const HOUR = 60 * 60 * 1000;
const MAX_KEYS = 10_000;

export function createLimiter(max: number, windowMs = HOUR) {
  const hits = new Map<string, number[]>();
  return function limited(key: string, now = Date.now()) {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return true;
    }
    // Drop the oldest caller rather than grow without bound.
    if (!hits.has(key) && hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value!);
    hits.delete(key);
    hits.set(key, [...recent, now]);
    return false;
  };
}

export const PER_IP = 5;
// Model calls: 5 an hour per caller, and at most 60 an hour per instance whoever is calling.
const perCaller = createLimiter(PER_IP);
const perInstance = createLimiter(60);
export const limited = (ip: string) => perCaller(ip) || perInstance("all");

// Usage events written by the MCP server: one blob write each, so cap them per caller.
export const eventLimited = createLimiter(60);

// Vercel sets x-forwarded-for and x-real-ip to the connecting client and overwrites any value the
// client sent. Elsewhere (for example `next start` behind no proxy) both are client-controlled.
export const clientIp = (headers: Headers) =>
  headers.get("x-real-ip")?.trim() || headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
