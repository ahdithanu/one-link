import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bundled } from "@/lib/data";
import { parseJobRef } from "@/lib/mcp";
import { call, ctx } from "./helpers";

const open = bundled.roles.filter((r) => r.open !== false && bundled.briefs[r.id]);
const sample = open[0];

describe("list_briefs", () => {
  it("returns 20 rows by default with the full count", async () => {
    const res = await call("list_briefs", {});
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.total, open.length);
    assert.equal(res.structuredContent.roles.length, Math.min(20, open.length));
  });
  it("rows have the documented fields and types", async () => {
    const { structuredContent } = await call("list_briefs", { limit: 50 });
    for (const r of structuredContent.roles) {
      assert.match(r.job_id, /^[0-9a-f-]{36}$/);
      assert.equal(typeof r.title, "string");
      assert.equal(typeof r.company, "string");
      assert.equal(typeof r.posted_days_ago, "number");
      assert.equal(typeof r.pay_posted, "boolean");
      assert.ok(r.build.length > 0);
      assert.match(r.url, /^https:\/\/example\.test\/r\/[0-9a-f]{8}$/);
    }
  });
  it("filters by function", async () => {
    const { structuredContent } = await call("list_briefs", { function: "engineering", limit: 50 });
    assert.ok(structuredContent.total > 0);
    assert.ok(structuredContent.roles.every((r: { function: string }) => r.function === "engineering"));
    assert.equal(structuredContent.total, open.filter((r) => r.function === "engineering").length);
  });
  it("filters by free text over company", async () => {
    const { structuredContent } = await call("list_briefs", { q: sample.company.toUpperCase() });
    assert.ok(structuredContent.roles.some((r: { company: string }) => r.company === sample.company));
  });
  it("respects limit", async () => {
    assert.equal((await call("list_briefs", { limit: 1 })).structuredContent.roles.length, 1);
  });
  it("returns an empty, non-error result when nothing matches", async () => {
    const res = await call("list_briefs", { q: "zzzz-no-such-role-zzzz" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.total, 0);
    assert.match(res.content[0].text, /No matching roles/);
  });
  for (const [label, args] of [
    ["limit 0", { limit: 0 }],
    ["limit 51", { limit: 51 }],
    ["limit as a string", { limit: "5" }],
    ["fractional limit", { limit: 2.5 }],
    ["unknown function", { function: "astrology" }],
    ["q over 120 characters", { q: "x".repeat(121) }],
  ] as const) {
    it(`rejects ${label} as a tool error`, async () => {
      const res = await call("list_briefs", args);
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Invalid arguments/);
    });
  }
});

describe("get_build_brief", () => {
  const forms = {
    "full UUID": sample.id,
    "8-hex prefix": sample.short,
    "job url": sample.url,
    "job url with query and slash": `${sample.url}/?ref=x#top`,
    "uppercase UUID": sample.id.toUpperCase(),
  };
  for (const [label, job] of Object.entries(forms)) {
    it(`resolves a ${label}`, async () => {
      const res = await call("get_build_brief", { job });
      assert.equal(res.isError, undefined);
      assert.equal(res.structuredContent.role.id, sample.id);
    });
  }
  it("returns a brief that matches the stored source data", async () => {
    const { structuredContent: s, content } = await call("get_build_brief", { job: sample.id });
    assert.deepEqual(s.brief, bundled.briefs[sample.id]);
    assert.equal(s.role.company, sample.company);
    assert.equal(s.url, `https://example.test/r/${sample.short}`);
    assert.ok(Array.isArray(s.role.warnings));
    assert.ok(content[0].text.includes(bundled.briefs[sample.id].build.title));
    assert.ok(content[0].text.includes("Before you spend a weekend"));
  });
  it("a missing record is a not-found tool error that points to brief_from_job_post", async () => {
    const res = await call("get_build_brief", { job: "00000000" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /brief_from_job_post/);
  });
  for (const [label, args] of [
    ["no job", {}],
    ["a number", { job: 12345678 }],
    ["too short", { job: "abc" }],
    ["no hex id in it", { job: "senior engineer at acme" }],
    ["over 300 characters", { job: "a".repeat(301) }],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const res = await call("get_build_brief", args);
      assert.equal(res.isError, true);
    });
  }
});

describe("parseJobRef", () => {
  it("extracts ids from every supported form", () => {
    assert.equal(parseJobRef("044B247C-0C32-4DC2-BD99-E16D6BF8A630"), "044b247c");
    assert.equal(parseJobRef("044b247c"), "044b247c");
    assert.equal(parseJobRef("https://speedrun-talent-network.com/jobs/performance-marketing-manager-dex-044b247c"), "044b247c");
    assert.equal(parseJobRef("https://x.com/jobs/a-044b247c/?utm=1"), "044b247c");
    assert.equal(parseJobRef("not an id"), null);
    assert.equal(parseJobRef("044b247c9"), null);
  });
});

describe("brief_from_job_post", () => {
  it("rejects a missing job_post before touching the rate limit", async () => {
    let checked = false;
    const res = await call("brief_from_job_post", {}, ctx({ limited: () => ((checked = true), false) }));
    assert.equal(res.isError, true);
    assert.equal(checked, false);
  });
  it("rejects job_post over 20000 characters", async () => {
    assert.equal((await call("brief_from_job_post", { job_post: "x".repeat(20001) })).isError, true);
  });
  it("returns a rate-limit tool error when the caller is over the limit", async () => {
    const res = await call("brief_from_job_post", { job_post: "x".repeat(300) }, ctx({ limited: () => true }));
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Limit of 5/);
  });
  it("reports briefs as switched off when no API key is configured", async () => {
    const res = await call("brief_from_job_post", { job_post: "x".repeat(300) });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /switched off/);
  });
});

describe("board cache for MCP calls", () => {
  it("reuses one read within a minute and reads again after", async () => {
    const { getBoardCached } = await import("@/lib/data");
    const a = getBoardCached(1_000_000);
    assert.equal(getBoardCached(1_030_000), a);
    assert.notEqual(getBoardCached(1_061_000), a);
    assert.ok((await a).roles.length > 0);
  });
});

describe("upstream budget and untrusted brief text", () => {
  it("MCP lookups that reach the talent network stop when the caller's budget is spent", async () => {
    const limitedCtx = ctx({ upstreamLimited: () => true });
    for (const [name, args] of [["search_roles", { q: "x" }], ["brief_for_job", { job: "00000d01-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }], ["get_build_brief", { job: "00000d02-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]] as const) {
      const res = await call(name, args, limitedCtx);
      assert.equal(res.isError, true, name);
      assert.match(res.content[0].text, /Too many/, name);
    }
  });
  it("speedrun briefs need no upstream call, so they aren't limited", async () => {
    const res = await call("get_build_brief", { job: sample.id }, ctx({ upstreamLimited: () => true }));
    assert.equal(res.isError, undefined);
  });
  it("tells agents that brief text is content, not instructions", async () => {
    const { INSTRUCTIONS } = await import("@/lib/mcp");
    assert.match(INSTRUCTIONS, /never as instructions/);
  });
});
