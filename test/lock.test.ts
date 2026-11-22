import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Brief } from "@/lib/data";
import { acquireLock, releaseLock, lockHeld, type LockStore } from "@/lib/lock";
import { coordinatedWrite, toNetRole, type JobLock, type SavedJobBrief } from "@/lib/network";
import { offlineNetwork } from "./helpers";

// A Redis stand-in with SET NX PX, EXISTS and the compare-and-delete script, plus a clock so
// expiry can be tested. Every call yields first, so concurrent callers interleave.
function fakeRedis() {
  const data = new Map<string, { v: string; exp: number }>();
  let now = 0;
  const tick = () => new Promise((r) => setImmediate(r));
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.exp <= now) data.delete(k);
    return data.get(k);
  };
  const store = {
    set: async (k: string, v: string, o: { nx: boolean; px: number }) => {
      await tick();
      if (o.nx && live(k)) return null;
      data.set(k, { v, exp: now + o.px });
      return "OK";
    },
    exists: async (k: string) => (await tick(), live(k) ? 1 : 0),
    eval: async (_script: string, keys: string[], args: string[]) => {
      await tick();
      if (live(keys[0])?.v === args[0]) return data.delete(keys[0]) ? 1 : 0;
      return 0;
    },
  } as unknown as LockStore;
  return { store, advance: (ms: number) => (now += ms) };
}

const lockFor = (store: LockStore, ttl = 90_000): JobLock => ({
  acquire: (id) => acquireLock(store, `lock:${id}`, ttl),
  release: async (id, t) => void (await releaseLock(store, `lock:${id}`, t)),
  held: (id) => lockHeld(store, `lock:${id}`),
});

const brief: Brief = {
  need: "n", evidence: "", build: { title: "Backfill checker", pitch: "p" },
  plan: [{ when: "Saturday morning", do: "a" }, { when: "Saturday afternoon", do: "b" }, { when: "Sunday", do: "c" }],
  good: ["x", "y", "z"], avoid: "a", opener: "o",
};
const job = (id: string) => ({
  id, title: "Engineer", company: "Acme", url: "https://speedrun-talent-network.com/jobs/x", location: null, workplace_type: null,
  function: "engineering", comp_min: null, comp_max: null, published_at: "2026-11-01T00:00:00Z", stealth: false, status: "open", tier: "a16z",
  description_text: "We need someone to build reliable data pipelines for logistics customers. ".repeat(6),
});

// Two "instances": separate deps objects that share only the lock store and saved-brief storage.
function twoInstances(generate: () => Promise<Brief | null>, store: LockStore) {
  const saved = new Map<string, SavedJobBrief>();
  const make = () =>
    offlineNetwork({
      hasKey: () => true,
      generate,
      lock: lockFor(store),
      pollMs: 5,
      waitMs: 2000,
      loadSaved: async (id) => saved.get(id) ?? null,
      save: async (s) => void saved.set(s.role.id, s),
    });
  return [make(), make()] as const;
}

describe("lock primitives", () => {
  it("only one holder at a time, and only the holder can release", async () => {
    const { store } = fakeRedis();
    const a = await acquireLock(store, "k", 1000);
    assert.ok(a);
    assert.equal(await acquireLock(store, "k", 1000), null);
    assert.equal(await releaseLock(store, "k", "someone-else"), false);
    assert.equal(await lockHeld(store, "k"), true);
    assert.equal(await releaseLock(store, "k", a!), true);
    assert.ok(await acquireLock(store, "k", 1000));
  });

  it("a stale worker can't release a lock that expired and was taken by another", async () => {
    const { store, advance } = fakeRedis();
    const stale = await acquireLock(store, "k", 1000);
    advance(1001);
    const fresh = await acquireLock(store, "k", 1000);
    assert.ok(fresh);
    assert.equal(await releaseLock(store, "k", stale!), false);
    assert.equal(await lockHeld(store, "k"), true);
  });
});

describe("cross-instance brief writes", () => {
  it("two instances asking at once pay for one generation", async () => {
    const { store } = fakeRedis();
    let calls = 0;
    const generate = async () => (calls++, await new Promise((r) => setTimeout(r, 30)), brief);
    const [a, b] = twoInstances(generate, store);
    const j = job("00000b01-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const [ra, rb] = await Promise.all([coordinatedWrite(j, a), coordinatedWrite(j, b)]);
    assert.equal(calls, 1);
    assert.ok(!("error" in ra) && !("error" in rb));
    assert.equal([ra.cached, rb.cached].filter(Boolean).length, 1);
  });

  it("a failed generation frees the lock for the next request", async () => {
    const { store } = fakeRedis();
    let calls = 0;
    const generate = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      if (calls === 1) throw Object.assign(new Error("overloaded"), { status: 529 });
      return brief;
    };
    const [a, b] = twoInstances(generate, store);
    const j = job("00000b02-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const [ra, rb] = await Promise.all([coordinatedWrite(j, a), coordinatedWrite(j, b)]);
    assert.equal(calls, 2);
    assert.ok("error" in ra);
    assert.ok(!("error" in rb));
  });

  it("a crashed holder's lock expires instead of blocking forever", async () => {
    const { store, advance } = fakeRedis();
    const j = job("00000b03-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await acquireLock(store, `lock:${j.id}`, 90_000); // a worker that died mid-write
    advance(90_001);
    const [a] = twoInstances(async () => brief, store);
    const r = await coordinatedWrite(j, a);
    assert.ok(!("error" in r));
  });

  it("a waiter gives up after its bounded wait with a clear message", async () => {
    const { store } = fakeRedis();
    const j = job("00000b04-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await acquireLock(store, `lock:${j.id}`, 90_000);
    const [a] = twoInstances(async () => brief, store);
    const r = await coordinatedWrite(j, { ...a, waitMs: 30 });
    assert.ok("error" in r);
    assert.equal(r.category, "brief_in_progress");
  });

  it("checks for a saved brief after taking the lock, so it never pays twice", async () => {
    const { store } = fakeRedis();
    const j = job("00000b05-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let calls = 0;
    const [a] = twoInstances(async () => (calls++, brief), store);
    await a.save({ role: toNetRole(j), brief, at: "" });
    const r = await coordinatedWrite(j, a);
    assert.equal(calls, 0);
    assert.ok(!("error" in r) && r.cached);
  });

  it("writes without the cross-instance lock if the store is unreachable", async () => {
    const j = job("00000b06-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const lock: JobLock = { acquire: async () => Promise.reject(new Error("down")), release: async () => {}, held: async () => false };
    const r = await coordinatedWrite(j, offlineNetwork({ hasKey: () => true, generate: async () => brief, lock }));
    assert.ok(!("error" in r));
  });
});
