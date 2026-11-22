import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callerKey, redisFromEnv, reserveDaily, sharedLimiter, type CounterStore } from "@/lib/limit";

describe("shared rate limiter", () => {
  it("uses the shared store's answer when it has one", async () => {
    const allow = sharedLimiter("t-allow", 1, async () => ({ success: true }));
    const deny = sharedLimiter("t-deny", 100, async () => ({ success: false }));
    assert.equal(await allow("a"), false);
    assert.equal(await allow("a"), false, "the shared store, not the local window, decides");
    assert.equal(await deny("a"), true);
  });

  it("falls back to the per-instance window when the store throws", async () => {
    const limit = sharedLimiter("t-throw", 2, async () => Promise.reject(new Error("redis down")));
    assert.deepEqual([await limit("k"), await limit("k"), await limit("k")], [false, false, true]);
  });

  it("treats a store timeout as unknown and uses the local window", async () => {
    const limit = sharedLimiter("t-timeout", 1, async () => ({ success: true, reason: "timeout" }));
    assert.deepEqual([await limit("k"), await limit("k")], [false, true]);
  });

  it("uses the local window when no store is configured", async () => {
    const limit = sharedLimiter("t-none", 1, null);
    assert.deepEqual([await limit("k"), await limit("k"), await limit("other")], [false, true, false]);
  });
});

describe("caller keys", () => {
  it("never contain the IP and are stable per secret", () => {
    const k = callerKey("203.0.113.9", "s1");
    assert.doesNotMatch(k, /203|113/);
    assert.equal(k, callerKey("203.0.113.9", "s1"));
    assert.notEqual(k, callerKey("203.0.113.9", "s2"));
    assert.notEqual(k, callerKey("203.0.113.10", "s1"));
  });
});

describe("store configuration", () => {
  it("is off without credentials", () => {
    assert.equal(redisFromEnv({}), null);
    assert.equal(redisFromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }), null);
  });
  it("reads either Upstash's or Vercel's variable names", () => {
    assert.ok(redisFromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }));
    assert.ok(redisFromEnv({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" }));
  });
});

// An in-memory stand-in for Redis INCR/DECR/EXPIRE. Each call yields to the event loop first, so
// concurrent reservations interleave the way they would against a real server.
function fakeStore() {
  const values = new Map<string, number>();
  const ttl = new Map<string, number>();
  const tick = () => new Promise((r) => setImmediate(r));
  const store = {
    incr: async (k: string) => (await tick(), values.set(k, (values.get(k) ?? 0) + 1), values.get(k)!),
    decr: async (k: string) => (await tick(), values.set(k, (values.get(k) ?? 0) - 1), values.get(k)!),
    expire: async (k: string, s: number) => (await tick(), ttl.set(k, s), 1),
  } as unknown as CounterStore;
  return { store, values, ttl };
}

describe("daily brief budget", () => {
  it("never hands out more slots than the cap, even under concurrent requests", async () => {
    const { store, values } = fakeStore();
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveDaily(store, 3, "2026-11-22")));
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(values.get("one-link:spend:2026-11-22"), 3);
  });

  it("expires the day's counter and gives a slot back on release", async () => {
    const { store, values, ttl } = fakeStore();
    const release = await reserveDaily(store, 5, "2026-11-23");
    assert.ok(release);
    assert.equal(ttl.get("one-link:spend:2026-11-23"), 2 * 24 * 60 * 60);
    await release();
    assert.equal(values.get("one-link:spend:2026-11-23"), 0);
  });

  it("a cap of zero turns new briefs off", async () => {
    const { store } = fakeStore();
    assert.equal(await reserveDaily(store, 0, "2026-11-24"), null);
  });
});

describe("sliding window on the store", () => {
  it("a store that doesn't answer in time counts as a timeout, not a pass", async () => {
    const { slidingWindow } = await import("@/lib/limit");
    const never = { eval: () => new Promise(() => {}) } as never;
    const remote = slidingWindow(never, "t", 5, 1000, 20);
    assert.deepEqual(await remote("k"), { success: true, reason: "timeout" });
  });

  it("passes the window, limit and a unique member to one atomic script", async () => {
    const { slidingWindow } = await import("@/lib/limit");
    const calls: unknown[][] = [];
    const store = { eval: async (...a: unknown[]) => (calls.push(a), 0) } as never;
    assert.deepEqual(await slidingWindow(store, "brief-caller", 5)("abc"), { success: false });
    const [script, keys, args] = calls[0] as [string, string[], string[]];
    assert.match(script, /ZREMRANGEBYSCORE[\s\S]*ZCARD[\s\S]*ZADD/);
    assert.deepEqual(keys, ["one-link:rl:brief-caller:abc"]);
    assert.equal(args[0], String(60 * 60 * 1000));
    assert.equal(args[1], "5");
  });

  it("logs once when it falls back to per-instance limits", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => void warnings.push(m);
    try {
      const limit = sharedLimiter("t-warn", 3, async () => Promise.reject(new Error("down")));
      await limit("a");
      await limit("b");
    } finally {
      console.warn = orig;
    }
    assert.ok(warnings.length <= 1);
  });
});
