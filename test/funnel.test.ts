import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { briefRate, funnel } from "@/lib/funnel";
import { makeBrief, type MakeBriefDeps } from "@/lib/make-brief";
import { sourceFrom } from "@/lib/source";
import { eventPath, parseEventPath, type EventRow } from "@/lib/store";

const HOST = "one-link-eta.vercel.app";

describe("source buckets", () => {
  it("prefers utm_source, with aliases, and never stores anything else", () => {
    assert.equal(sourceFrom("", "?utm_source=linkedin", HOST), "linkedin");
    assert.equal(sourceFrom("https://t.co/abc", "?utm_source=Instagram&utm_medium=bio", HOST), "instagram");
    assert.equal(sourceFrom("", "?utm_source=twitter", HOST), "x");
    assert.equal(sourceFrom("", "?utm_source=my-secret-campaign", HOST), "other");
    // agent is reserved for the MCP server
    assert.equal(sourceFrom("", "?utm_source=agent", HOST), "other");
  });

  it("buckets referrers by host", () => {
    const cases: [string, string][] = [
      ["https://www.linkedin.com/feed/", "linkedin"],
      ["https://lnkd.in/xyz", "linkedin"],
      ["https://t.co/abc", "x"],
      ["https://x.com/someone/status/1", "x"],
      ["https://l.instagram.com/?u=", "instagram"],
      ["https://medium.com/@me/post", "medium"],
      ["https://someone.medium.com/post", "medium"],
      ["https://news.ycombinator.com/item?id=1", "hn"],
      ["https://www.google.co.uk/", "google"],
      ["https://mail.google.com/mail/u/0/", "email"],
      ["https://example.org/blog", "other"],
      [`https://${HOST}/why`, "direct"],
      ["not a url", "other"],
    ];
    for (const [ref, want] of cases) assert.equal(sourceFrom(ref, "", HOST), want, ref);
    assert.equal(sourceFrom("", "", HOST), "direct");
  });
});

describe("event paths", () => {
  it("round-trips the dated, sourced shape and reads the old one as untracked", () => {
    assert.deepEqual(parseEventPath(eventPath("visit", "linkedin", "2026-11-24", "u1")), { name: "visit", day: "2026-11-24", source: "linkedin" });
    assert.deepEqual(parseEventPath("events/brief_created/0a1b2c"), { name: "brief_created", day: null, source: null });
  });

  it("ignores anything it doesn't recognize", () => {
    for (const p of ["events/nope/x", "events/visit/2026-11-24/martians/x", "events/visit/yesterday/x/y", "briefs/abc.json", "events/visit/a/b/c/d"]) assert.equal(parseEventPath(p), null, p);
  });
});

describe("funnel", () => {
  const rows: EventRow[] = [
    { name: "visit", day: "2026-11-24", source: "linkedin" },
    { name: "visit", day: "2026-11-24", source: "linkedin" },
    { name: "visit", day: "2026-11-23", source: "x" },
    { name: "brief_created", day: "2026-11-24", source: "linkedin" },
    { name: "agent_brief", day: "2026-11-24", source: "agent" },
    { name: "visit", day: "2026-10-01", source: "x" },
    { name: "visit", day: null, source: null },
    { name: "link_added", day: null, source: null },
  ];
  const f = funnel(rows, 3, new Date("2026-11-24T12:00:00Z"));

  it("totals by source, most visits first, and keeps untracked events apart", () => {
    assert.deepEqual(f.sources.map((s) => [s.source, s.counts.visit, s.counts.brief_created, s.counts.agent_brief]), [
      ["linkedin", 2, 1, 0],
      ["x", 2, 0, 0],
      ["agent", 0, 0, 1],
    ]);
    assert.equal(f.before.visit, 1);
    assert.equal(f.before.link_added, 1);
  });

  it("lists every recent day, including empty ones, and leaves older days out", () => {
    assert.deepEqual(f.daily.map((d) => [d.day, d.counts.visit]), [
      ["2026-11-24", 2],
      ["2026-11-23", 1],
      ["2026-11-22", 0],
    ]);
  });

  it("computes visit to brief", () => {
    assert.equal(briefRate(f.sources[0].counts), 50);
    assert.equal(briefRate(f.sources[2].counts), null);
  });
});

describe("brief_created carries the source", () => {
  const POST = "We are hiring a founding engineer. ".repeat(10);
  const deps = (seen: string[]): MakeBriefDeps => ({
    hasKey: () => true,
    fetchPost: async () => null,
    generate: async () => ({ company: "A", title: "B", need: "", evidence: "", build: { title: "", pitch: "" }, plan: [], good: [], avoid: "", opener: "" }),
    save: async () => "abcdefghijkl",
    record: async (s) => void seen.push(s),
  });

  it("records the visitor's source, and nothing for an internal browser", async () => {
    const seen: string[] = [];
    await makeBrief(POST, deps(seen), "linkedin");
    await makeBrief(POST, deps(seen), null);
    await makeBrief(POST, deps(seen));
    assert.deepEqual(seen, ["linkedin", "other"]);
  });
});
