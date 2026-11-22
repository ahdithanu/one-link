import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plan, type StoredBlob } from "@/lib/retention";

const now = new Date("2026-11-22T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const b = (pathname: string, age = 0): StoredBlob => ({ pathname, uploadedAt: daysAgo(age), size: 10 });
const open = new Map<string, boolean | null>([["job-open", true], ["job-closed", false], ["job-unknown", null]]);
const decide = (blobs: StoredBlob[]) => Object.fromEntries(plan(blobs, now, (id) => open.get(id) ?? null).map((d) => [d.pathname, d.action]));

describe("retention policy", () => {
  it("never removes the board, shared briefs or usage events, however old", () => {
    const d = decide([b("board/latest.json", 400), b("briefs/abc123def456.json", 400), b("events/visit/uuid-1", 400)]);
    assert.deepEqual(Object.values(d), ["keep", "keep", "keep"]);
  });

  it("keeps today's and recent spend markers, which the budget counts", () => {
    const d = decide([b("spend/2026-11-22/a"), b("spend/2026-11-21/b"), b("spend/2026-11-20/c"), b("spend/2026-11-19/d")]);
    assert.deepEqual(d, { "spend/2026-11-22/a": "keep", "spend/2026-11-21/b": "keep", "spend/2026-11-20/c": "keep", "spend/2026-11-19/d": "delete" });
  });

  it("keeps network briefs for open roles and for roles whose status is unknown", () => {
    const d = decide([b("jobbriefs/job-open.json", 300), b("jobbriefs/job-unknown.json", 300)]);
    assert.deepEqual(Object.values(d), ["keep", "keep"]);
  });

  it("removes a closed role's brief only after the 30-day grace period", () => {
    const d = decide([b("jobbriefs/job-closed.json", 10), { ...b("jobbriefs/job-closed.json", 31), pathname: "jobbriefs/job-closed.json?old" }]);
    assert.equal(d["jobbriefs/job-closed.json"], "keep");
    const old = plan([b("jobbriefs/job-closed.json", 31)], now, (id) => open.get(id) ?? null)[0];
    assert.equal(old.action, "delete");
  });

  it("leaves anything it doesn't recognize alone", () => {
    assert.deepEqual(Object.values(decide([b("something/else", 999), b("spend/not-a-date/x", 999)])), ["keep", "keep"]);
  });
});
