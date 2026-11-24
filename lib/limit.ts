import { createHmac, randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

// Rate limits. With Upstash Redis configured, every limit is counted in Redis and holds across all
// server instances. Without it, or when Redis errors or is slow, each limit falls back to a
// sliding window in this instance's memory, so an outage weakens the limits but never removes them.
// The Anthropic workspace spend cap stays the hard ceiling on model cost.

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

// Vercel's Upstash integration sets KV_REST_API_*; a database made on upstash.com uses UPSTASH_REDIS_REST_*.
export function redisFromEnv(env: Record<string, string | undefined> = process.env): Redis | null {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token, enableTelemetry: false, retry: { retries: 1, backoff: () => 50 } });
}

let redis: Redis | null | undefined;
export const getRedis = () => (redis === undefined ? (redis = redisFromEnv()) : redis);
export const limitMode = () => (getRedis() ? "shared" : "per-instance");

// Raw IPs never go to Redis: callers are keyed by an HMAC of the IP with the Redis token as the key.
export function callerKey(ip: string, secret = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "local") {
  return createHmac("sha256", secret).update(ip).digest("base64url").slice(0, 22);
}

type Remote = (key: string) => Promise<{ success: boolean; reason?: string }>;

// Sliding-window log in one atomic script: drop entries older than the window, count the rest,
// admit if under the limit. It uses the Redis server's clock, so every instance agrees on time,
// and only plain commands, so it runs the same on Upstash and on a local Redis.
const SLIDING_WINDOW = `
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
redis.call("ZREMRANGEBYSCORE", KEYS[1], 0, now - window)
if redis.call("ZCARD", KEYS[1]) < tonumber(ARGV[2]) then
  redis.call("ZADD", KEYS[1], now, ARGV[3])
  redis.call("PEXPIRE", KEYS[1], window)
  return 1
end
return 0`;

export type ScriptStore = Pick<Redis, "eval">;
export function slidingWindow(store: ScriptStore, name: string, max: number, windowMs = HOUR, timeoutMs = 1500): Remote {
  return async (key) => {
    const call = store.eval(SLIDING_WINDOW, [`one-link:rl:${name}:${key}`], [String(windowMs), String(max), randomUUID()]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
    try {
      const res = await Promise.race([call, timeout]);
      return res === "timeout" ? { success: true, reason: "timeout" } : { success: Number(res) === 1 };
    } finally {
      clearTimeout(timer);
    }
  };
}

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn(JSON.stringify({ event: "rate_limit_fallback", detail: "shared store unavailable, using per-instance limits" }));
}

function remoteFor(name: string, max: number): Remote | null {
  const r = getRedis();
  return r ? slidingWindow(r, name, max) : null;
}

// Returns true when `key` is over the limit.
export function sharedLimiter(name: string, max: number, remote: Remote | null = remoteFor(name, max)) {
  const local = createLimiter(max);
  return async (key: string): Promise<boolean> => {
    if (remote) {
      try {
        const res = await remote(key);
        // A slow store answers "timeout": treat that as unknown and use the local window.
        if (res.reason !== "timeout") return !res.success;
      } catch {
        // fall through to the local window
      }
      warnOnce();
    }
    return local(key);
  };
}

export const PER_IP = 5;
export const PER_HOUR_ALL = 60;
// Model calls: 5 an hour per caller, and 60 an hour across everyone (per instance without Redis).
const perCaller = sharedLimiter("brief-caller", PER_IP);
const perAll = sharedLimiter("brief-all", PER_HOUR_ALL);
export const limited = async (ip: string) => (await perCaller(callerKey(ip))) || (await perAll("all"));

// Usage events (one blob write each) and network searches, per caller.
const events = sharedLimiter("event", 60);
export const eventLimited = (ip: string) => events(callerKey(ip));
const pageEvents = sharedLimiter("page-event", 60);
export const pageEventLimited = (ip: string) => pageEvents(callerKey(ip));
// Every request that can reach the talent network API (search, role lookups, job pages) shares one
// per-caller budget, so no one can drive unlimited upstream calls through One Link.
const searches = sharedLimiter("search", 600);
export const searchLimited = (ip: string) => searches(callerKey(ip));
export const upstreamLimited = searchLimited;

// Daily brief budget, reserved before the model call so concurrent requests can't overshoot it.
// Returns false when the day's budget is used up. INCR is atomic, so this holds across instances.
export type CounterStore = Pick<Redis, "incr" | "decr" | "expire">;
export async function reserveDaily(store: CounterStore, cap: number, day = new Date().toISOString().slice(0, 10)) {
  const key = `one-link:spend:${day}`;
  const n = await store.incr(key);
  if (n === 1) await store.expire(key, 2 * 24 * 60 * 60);
  if (n > cap) {
    await store.decr(key);
    return null;
  }
  return async () => {
    await store.decr(key);
  };
}

// Vercel sets x-forwarded-for and x-real-ip to the connecting client and overwrites any value the
// client sent. Elsewhere (for example `next start` behind no proxy) both are client-controlled.
export const clientIp = (headers: Headers) =>
  headers.get("x-real-ip")?.trim() || headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

// Guesses at the /stats key: 10 an hour per caller.
const statsLogins = sharedLimiter("stats-login", 10);
export const statsLoginLimited = (ip: string) => statsLogins(callerKey(ip));
