import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BreakerOpenError, createBreaker } from "@/lib/breaker";
import { getJson, talentBreaker, ttlCache } from "@/lib/network";

describe("circuit breaker", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };
  const fail = () => Promise.reject(new Error("down"));

  it("opens after the failure threshold, fails fast, then lets one trial through", async () => {
    const c = clock();
    const transitions: string[] = [];
    const b = createBreaker({ failureThreshold: 3, openMs: 1000, now: c.now, onTransition: (f, t) => transitions.push(`${f}>${t}`) });
    for (let i = 0; i < 3; i++) await assert.rejects(b.run(fail));
    assert.equal(b.snapshot().state, "open");
    let called = false;
    await assert.rejects(b.run(async () => ((called = true), 1)), BreakerOpenError);
    assert.equal(called, false, "open circuit doesn't call upstream");
    c.advance(1000);
    assert.equal(await b.run(async () => 42), 42);
    assert.equal(b.snapshot().state, "closed");
    assert.deepEqual(transitions, ["closed>open", "open>half-open", "half-open>closed"]);
  });

  it("a failed trial reopens it", async () => {
    const c = clock();
    const b = createBreaker({ failureThreshold: 1, openMs: 1000, now: c.now });
    await assert.rejects(b.run(fail));
    c.advance(1000);
    await assert.rejects(b.run(fail));
    assert.equal(b.snapshot().state, "open");
  });

  it("only one trial call at a time while half-open", async () => {
    const c = clock();
    const b = createBreaker({ failureThreshold: 1, openMs: 10, now: c.now });
    await assert.rejects(b.run(fail));
    c.advance(10);
    let release!: () => void;
    const trial = b.run(() => new Promise<void>((r) => (release = r)));
    await assert.rejects(b.run(async () => 1), BreakerOpenError);
    release();
    await trial;
    assert.equal(b.snapshot().state, "closed");
  });

  it("failures outside the window don't count", async () => {
    const c = clock();
    const b = createBreaker({ failureThreshold: 2, windowMs: 100, now: c.now });
    await assert.rejects(b.run(fail));
    c.advance(101);
    await assert.rejects(b.run(fail));
    assert.equal(b.snapshot().state, "closed");
  });
});

describe("talent API client", () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realWarn = console.warn;
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.warn = realWarn;
    talentBreaker.reset();
  });
  const respond = (statuses: number[]) => {
    let i = 0;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return new Response(status === 200 ? JSON.stringify({ ok: true }) : "{}", { status });
    }) as typeof fetch;
    return calls;
  };
  const quiet = () => {
    const lines: string[] = [];
    console.log = (m: string) => void lines.push(m);
    console.warn = (m: string) => void lines.push(m);
    return lines;
  };
  const URL_ = "https://speedrun-talent-network.com/api/v1/jobs?q=secret-query&source=one-link";

  it("retries a 5xx once, then succeeds", async () => {
    quiet();
    const calls = respond([503, 200]);
    assert.deepEqual(await getJson(URL_), { ok: true });
    assert.equal(calls.length, 2);
  });

  it("never retries a 429, so it respects their rate limit", async () => {
    quiet();
    const calls = respond([429]);
    await assert.rejects(getJson(URL_));
    assert.equal(calls.length, 1);
  });

  it("a 404 is an answer: no retry, and the breaker stays closed", async () => {
    quiet();
    const calls = respond([404]);
    for (let i = 0; i < 8; i++) await assert.rejects(getJson("https://speedrun-talent-network.com/api/v1/jobs/deadbeef?source=one-link"));
    assert.equal(calls.length, 8);
    assert.equal(talentBreaker.snapshot().state, "closed");
  });

  it("repeated outages open the breaker and stop calling upstream", async () => {
    quiet();
    const calls = respond([500]);
    for (let i = 0; i < 5; i++) await assert.rejects(getJson(URL_));
    assert.equal(talentBreaker.snapshot().state, "open");
    const before = calls.length;
    await assert.rejects(getJson(URL_), BreakerOpenError);
    assert.equal(calls.length, before);
  });

  it("logs one structured line per call without the query", async () => {
    const lines = quiet();
    respond([200]);
    await getJson(URL_);
    const line = JSON.parse(lines.find((l) => l.includes('"talent_api"'))!);
    assert.equal(line.op, "search");
    assert.equal(line.ok, true);
    assert.equal(typeof line.duration_ms, "number");
    assert.doesNotMatch(lines.join("\n"), /secret-query/);
  });
});

describe("cache fallback", () => {
  it("serves the last good value, marked stale, when a fresh load fails", async () => {
    const cache = ttlCache<string>(0);
    assert.deepEqual(await cache("k", async () => "fresh"), { value: "fresh" });
    const stale = await cache("k", async () => Promise.reject(new Error("down")));
    assert.equal(stale.value, "fresh");
    assert.equal(typeof stale.staleMs, "number");
  });

  it("with no good value, the failure surfaces", async () => {
    const cache = ttlCache<string>(0);
    await assert.rejects(cache("never-loaded", async () => Promise.reject(new Error("down"))));
  });
});
