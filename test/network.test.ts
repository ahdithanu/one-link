import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bundled, type Brief } from "@/lib/data";
import { getNetworkJob, lookupJobBrief, MAX_PAGE, searchNetwork, toNetRole, writeJobBrief, type NetworkDeps } from "@/lib/network";
import { call, ctx, offlineNetwork } from "./helpers";

// Distinct ids and queries per test: search and job lookups are cached for the life of the process.
let seq = 0;
const freshId = () => {
  const n = (++seq).toString(16).padStart(8, "0");
  return `${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
};

const DESC = "We are hiring a staff engineer to own our data platform. ".repeat(10);
const job = (over: Record<string, unknown> = {}) => ({
  id: freshId(),
  title: "Staff Engineer",
  company: "Acme",
  url: "https://speedrun-talent-network.com/jobs/staff-engineer-acme",
  location: "New York",
  workplace_type: "Onsite",
  function: "engineering",
  comp_min: null,
  comp_max: null,
  published_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  stealth: false,
  status: "open",
  tier: "a16z",
  description_text: DESC,
  ...over,
});

const brief: Brief = {
  need: "A reliable data platform",
  evidence: "own our data platform",
  build: { title: "Backfill checker", pitch: "A tool that checks backfills." },
  plan: [
    { when: "Saturday morning", do: "a" },
    { when: "Saturday afternoon", do: "b" },
    { when: "Sunday", do: "c" },
  ],
  good: ["x", "y", "z"],
  avoid: "Don't do a toy.",
  opener: "I built a backfill checker for Acme.",
};

const sample = bundled.roles.find((r) => r.open !== false && bundled.briefs[r.id])!;

describe("toNetRole", () => {
  it("doesn't apply speedrun pay bands to other companies", () => {
    assert.deepEqual(toNetRole(job()).pay, { kind: "unposted" });
  });
  it("keeps posted pay", () => {
    assert.deepEqual(toNetRole(job({ comp_min: 150000, comp_max: 200000 })).pay, { kind: "posted", min: 150000, max: 200000 });
  });
  it("keeps the band estimate for speedrun roles", () => {
    assert.equal(toNetRole(job({ tier: "speedrun" })).pay.kind, "estimate");
  });
  it("computes the age in days", () => {
    assert.equal(toNetRole(job()).ageDays, 3);
  });
});

describe("searchNetwork", () => {
  it("passes q, fn and page, and drops stealth roles", async () => {
    const urls: string[] = [];
    const deps = { getJson: async (url: string) => (urls.push(url), { total: 2, has_more: true, jobs: [job(), job({ stealth: true })] }) };
    const res = await searchNetwork({ q: "data platform 1", fn: "engineering", page: 2 }, deps);
    const u = new URL(urls[0]);
    assert.equal(u.searchParams.get("q"), "data platform 1");
    assert.equal(u.searchParams.get("fn"), "engineering");
    assert.equal(u.searchParams.get("page"), "2");
    assert.equal(u.searchParams.get("scope"), "all");
    assert.equal(res.roles.length, 1);
    assert.equal(res.hasMore, true);
  });
  it("caches identical searches", async () => {
    let calls = 0;
    const deps = { getJson: async () => (calls++, { total: 0, jobs: [] }) };
    await searchNetwork({ q: "cache me" }, deps);
    await searchNetwork({ q: "cache me" }, deps);
    assert.equal(calls, 1);
  });
  it("ignores a malformed function and clamps the page", async () => {
    const urls: string[] = [];
    const deps = { getJson: async (url: string) => (urls.push(url), { total: 0, jobs: [] }) };
    await searchNetwork({ q: "clamp", fn: "Engineering; drop", page: 9999 }, deps);
    const u = new URL(urls[0]);
    assert.equal(u.searchParams.get("fn"), null);
    assert.equal(u.searchParams.get("page"), String(MAX_PAGE));
  });
  it("doesn't cache a failure", async () => {
    let calls = 0;
    const deps = {
      getJson: async () => {
        calls++;
        if (calls === 1) throw new Error("down");
        return { total: 0, jobs: [] };
      },
    };
    await assert.rejects(searchNetwork({ q: "retry after failure" }, deps));
    await searchNetwork({ q: "retry after failure" }, deps);
    assert.equal(calls, 2);
  });
});

describe("getNetworkJob", () => {
  it("rejects ids that aren't job ids without calling out", async () => {
    let called = false;
    assert.equal(await getNetworkJob("../../etc", { getJson: async () => ((called = true), {}) }), null);
    assert.equal(called, false);
  });
  it("returns null when the API fails", async () => {
    assert.equal(await getNetworkJob(freshId(), offlineNetwork()), null);
  });
});

describe("lookupJobBrief", () => {
  it("finds speedrun briefs on the board by short or full id, without the network", async () => {
    for (const id of [sample.short, sample.id]) {
      const r = await lookupJobBrief(id, bundled, offlineNetwork());
      assert.equal(r.kind, "board");
    }
  });
  it("returns a saved brief", async () => {
    const j = job();
    const r = await lookupJobBrief(j.id, bundled, offlineNetwork({ getJson: async () => ({ job: j }), loadSaved: async () => ({ role: toNetRole(j), brief, at: "" }) }));
    assert.equal(r.kind, "saved");
  });
  it("returns the job when there is no brief yet", async () => {
    const j = job();
    const r = await lookupJobBrief(j.id, bundled, offlineNetwork({ getJson: async () => ({ job: j }) }));
    assert.equal(r.kind, "new");
  });
  it("reports missing and invalid ids", async () => {
    assert.equal((await lookupJobBrief(freshId(), bundled, offlineNetwork())).kind, "missing");
    assert.equal((await lookupJobBrief("nope", bundled, offlineNetwork())).kind, "invalid");
  });
});

describe("writeJobBrief", () => {
  const ready = (over: Partial<NetworkDeps> = {}) => offlineNetwork({ hasKey: () => true, generate: async () => brief, ...over });

  it("writes, saves and counts a new brief", async () => {
    let saved = 0;
    let counted = 0;
    const r = await writeJobBrief(job(), ready({ save: async () => void saved++, reserveBrief: async () => (counted++, async () => {}) }));
    assert.ok(!("error" in r));
    assert.equal(r.brief.build.title, "Backfill checker");
    assert.equal(saved, 1);
    assert.equal(counted, 1);
  });
  it("still returns the brief if saving fails", async () => {
    const r = await writeJobBrief(job(), ready({ save: async () => Promise.reject(new Error("blob down")) }));
    assert.ok(!("error" in r));
  });
  const failures: [string, Record<string, unknown>, Partial<NetworkDeps>, number, string][] = [
    ["no API key", {}, { hasKey: () => false }, 503, "model_unavailable"],
    ["closed role", { status: "closed" }, {}, 410, "not_found"],
    ["thin listing", { description_text: "Short." }, {}, 422, "not_a_job_post"],
    ["daily cap reached", {}, { reserveBrief: async () => null }, 503, "budget_exhausted"],
    ["cap count unavailable", {}, { reserveBrief: async () => Promise.reject(new Error("list failed")) }, 503, "budget_unavailable"],
    ["not a job post", {}, { generate: async () => null }, 422, "not_a_job_post"],
    ["model rate limit", {}, { generate: async () => Promise.reject(Object.assign(new Error("429"), { status: 429 })) }, 503, "model_rate_limited"],
    ["model error", {}, { generate: async () => Promise.reject(Object.assign(new Error("500"), { status: 500 })) }, 502, "model_error"],
  ];
  for (const [name, jobOver, depsOver, status, category] of failures) {
    it(`${name} -> ${status} ${category}`, async () => {
      const r = await writeJobBrief(job(jobOver), ready(depsOver));
      assert.ok("error" in r);
      assert.equal(r.status, status);
      assert.equal(r.category, category);
    });
  }
  it("doesn't call the model once the cap is reached", async () => {
    let generated = false;
    await writeJobBrief(job(), ready({ reserveBrief: async () => null, generate: async () => ((generated = true), brief) }));
    assert.equal(generated, false);
  });
  it("keeps the budget slot for a post the model rejected, since it cost a model call", async () => {
    let released = false;
    await writeJobBrief(job(), ready({ generate: async () => null, reserveBrief: async () => async () => void (released = true) }));
    assert.equal(released, false);
  });
  it("gives the budget slot back when the model call fails", async () => {
    let released = false;
    const generate = async () => Promise.reject(Object.assign(new Error("500"), { status: 500 }));
    await writeJobBrief(job(), ready({ generate, reserveBrief: async () => async () => void (released = true) }));
    assert.equal(released, true);
  });
  it("rethrows unexpected errors", async () => {
    await assert.rejects(writeJobBrief(job(), ready({ generate: async () => Promise.reject(new TypeError("bug")) })), TypeError);
  });
});

describe("search_roles tool", () => {
  it("marks which roles have a brief and links each to the right page", async () => {
    const other = job();
    const speedrun = job({ id: sample.id, tier: "speedrun" });
    const network = offlineNetwork({ getJson: async () => ({ total: 2, has_more: false, jobs: [other, speedrun] }) });
    const res = await call("search_roles", { q: "tool test unique" }, ctx({ network }));
    assert.equal(res.isError, undefined);
    const [a, b] = res.structuredContent.roles;
    assert.equal(a.has_brief, false);
    assert.equal(a.url, `https://example.test/j/${other.id}`);
    assert.equal(b.has_brief, true);
    assert.equal(b.url, `https://example.test/r/${sample.short}`);
  });
  it("rejects a malformed function as a tool error", async () => {
    const res = await call("search_roles", { function: "DROP TABLE" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Invalid arguments/);
  });
  it("says so when the network is down", async () => {
    const res = await call("search_roles", { q: "network down unique" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /didn't answer/);
  });
});

describe("brief_for_job tool", () => {
  it("returns a speedrun brief from the board", async () => {
    const res = await call("brief_for_job", { job: sample.id });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.url, `https://example.test/r/${sample.short}`);
  });
  it("returns a saved brief without using the caller's limit", async () => {
    const j = job();
    const network = offlineNetwork({ getJson: async () => ({ job: j }), loadSaved: async () => ({ role: toNetRole(j), brief, at: "" }) });
    const res = await call("brief_for_job", { job: j.id }, ctx({ network, limited: () => true }));
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.url, `https://example.test/j/${j.id}`);
  });
  it("checks the rate limit before writing a new brief", async () => {
    const j = job();
    let generated = false;
    const network = offlineNetwork({ hasKey: () => true, getJson: async () => ({ job: j }), generate: async () => ((generated = true), brief) });
    const res = await call("brief_for_job", { job: j.id }, ctx({ network, limited: () => true }));
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Limit of 5/);
    assert.equal(generated, false);
  });
  it("doesn't use the caller's limit when briefs are switched off", async () => {
    const j = job();
    let checked = false;
    const network = offlineNetwork({ getJson: async () => ({ job: j }) });
    const res = await call("brief_for_job", { job: j.id }, ctx({ network, limited: () => ((checked = true), false) }));
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /switched off/);
    assert.equal(checked, false);
  });
  it("writes a new brief and links to its page", async () => {
    const j = job();
    const network = offlineNetwork({ hasKey: () => true, getJson: async () => ({ job: j }), generate: async () => brief });
    const res = await call("brief_for_job", { job: j.id }, ctx({ network }));
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.url, `https://example.test/j/${j.id}`);
    assert.match(res.content[0].text, /Pay: Not posted\./);
  });
  it("reports an unknown job", async () => {
    const res = await call("brief_for_job", { job: freshId() });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No job with that id/);
  });
});

describe("get_build_brief on network roles", () => {
  it("returns a brief someone already asked for", async () => {
    const j = job();
    const network = offlineNetwork({ getJson: async () => ({ job: j }), loadSaved: async () => ({ role: toNetRole(j), brief, at: "" }) });
    const res = await call("get_build_brief", { job: j.id }, ctx({ network }));
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.brief.build.title, "Backfill checker");
  });
  it("points to brief_for_job when the role has no brief yet", async () => {
    const j = job();
    const res = await call("get_build_brief", { job: j.id }, ctx({ network: offlineNetwork({ getJson: async () => ({ job: j }) }) }));
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /brief_for_job/);
  });
});

describe("one brief write per job at a time", () => {
  // A generate() that waits until the test releases it, so two requests overlap.
  function gated() {
    let release!: (b: Brief | null) => void;
    let calls = 0;
    const generate = () => {
      calls++;
      return new Promise<Brief | null>((r) => (release = r));
    };
    return { generate, release: (b: Brief | null) => release(b), calls: () => calls };
  }

  it("a second request while the first is writing joins it instead of calling the model again", async () => {
    const j = job();
    const g = gated();
    let counted = 0;
    const deps = offlineNetwork({ hasKey: () => true, generate: g.generate, reserveBrief: async () => (counted++, async () => {}) });
    const first = writeJobBrief(j, deps);
    const second = writeJobBrief(j, deps);
    await new Promise((r) => setImmediate(r));
    g.release(brief);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(g.calls(), 1);
    assert.equal(counted, 1);
    assert.ok(!("error" in a) && !("error" in b));
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(b.usage, undefined);
  });

  it("lookup reports a brief being written as pending", async () => {
    const j = job();
    const g = gated();
    const deps = offlineNetwork({ hasKey: () => true, generate: g.generate, getJson: async () => ({ job: j }) });
    const writing = writeJobBrief(j, deps);
    assert.equal((await lookupJobBrief(j.id, bundled, deps)).kind, "pending");
    g.release(brief);
    await writing;
  });

  it("a failed write can be retried right away", async () => {
    const j = job();
    let calls = 0;
    const deps = offlineNetwork({ hasKey: () => true, generate: async () => (calls++ === 0 ? null : brief) });
    const first = await writeJobBrief(j, deps);
    assert.ok("error" in first);
    const second = await writeJobBrief(j, deps);
    assert.ok(!("error" in second));
    assert.equal(calls, 2);
  });

  it("brief_for_job joins a write in progress without using the caller's limit", async () => {
    const j = job();
    const g = gated();
    const network = offlineNetwork({ hasKey: () => true, generate: g.generate, getJson: async () => ({ job: j }) });
    const writing = writeJobBrief(j, network);
    const res = call("brief_for_job", { job: j.id }, ctx({ network, limited: () => true }));
    await new Promise((r) => setImmediate(r));
    g.release(brief);
    const out = await res;
    await writing;
    assert.equal(out.isError, undefined);
    assert.equal(g.calls(), 1);
  });

  it("get_build_brief says a brief is being written", async () => {
    const j = job();
    const g = gated();
    const network = offlineNetwork({ hasKey: () => true, generate: g.generate, getJson: async () => ({ job: j }) });
    const writing = writeJobBrief(j, network);
    const res = await call("get_build_brief", { job: j.id }, ctx({ network }));
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /being written right now/);
    g.release(brief);
    await writing;
  });
});

describe("finished writes on a frozen instance", () => {
  it("right after a successful write, lookup returns the brief, not 'being written'", async () => {
    const j = job();
    const deps = offlineNetwork({ hasKey: () => true, generate: async () => brief, getJson: async () => ({ job: j }) });
    await writeJobBrief(j, deps);
    const r = await lookupJobBrief(j.id, bundled, deps);
    assert.equal(r.kind, "saved");
  });

  it("a finished write is forgotten after a minute by the clock, with no timer involved", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const j = job();
    let calls = 0;
    const deps = offlineNetwork({ hasKey: () => true, generate: async () => (calls++, brief), getJson: async () => ({ job: j }) });
    await writeJobBrief(j, deps);
    t.mock.timers.tick(61_000);
    assert.equal((await lookupJobBrief(j.id, bundled, deps)).kind, "new", "nothing saved in this fake storage, so after the window it's new again");
    await writeJobBrief(j, deps);
    assert.equal(calls, 2);
  });
});
