import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bundled, type Brief } from "@/lib/data";
import { makeBrief } from "@/lib/make-brief";
import { OUTPUT } from "@/lib/mcp-output";
import { toNetRole } from "@/lib/network";
import { call, ctx, offlineNetwork, rpc } from "./helpers";

const sample = bundled.roles.find((r) => r.open !== false && bundled.briefs[r.id])!;
const brief: Brief = bundled.briefs[sample.id];
const netJob = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: "Platform Engineer",
  company: "Acme",
  url: "https://speedrun-talent-network.com/jobs/platform-engineer-acme",
  location: null,
  workplace_type: null,
  function: "engineering",
  comp_min: null,
  comp_max: null,
  published_at: "2026-11-01T00:00:00Z",
  stealth: false,
  status: "open",
  tier: "a16z",
  description_text: "We build data platforms for logistics teams. ".repeat(10),
  ...over,
});

function matches(name: keyof typeof OUTPUT, value: unknown) {
  const parsed = OUTPUT[name].safeParse(value);
  assert.ok(parsed.success, `${name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`);
}

describe("outputSchema", () => {
  it("every tool declares an object outputSchema", async () => {
    const { json } = await rpc("tools/list");
    for (const t of json.result.tools) {
      assert.equal(t.outputSchema?.type, "object", t.name);
      assert.ok(Array.isArray(t.outputSchema.required), t.name);
    }
  });

  it("get_build_brief (speedrun role) matches", async () => {
    const res = await call("get_build_brief", { job: sample.id });
    matches("get_build_brief", res.structuredContent);
  });

  it("list_briefs matches", async () => {
    matches("list_briefs", (await call("list_briefs", { limit: 50 })).structuredContent);
  });

  it("search_roles matches, including null locations", async () => {
    const network = offlineNetwork({ getJson: async () => ({ total: 2, has_more: true, jobs: [netJob("00000a01-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), netJob(sample.id, { tier: "speedrun", location: "NYC" })] }) });
    matches("search_roles", (await call("search_roles", { q: "schema check unique" }, ctx({ network }))).structuredContent);
  });

  it("brief_for_job matches for a new and a saved brief", async () => {
    const fresh = netJob("00000a02-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { comp_min: 150000, comp_max: 190000 });
    const network = offlineNetwork({ hasKey: () => true, getJson: async () => ({ job: fresh }), generate: async () => brief });
    matches("brief_for_job", (await call("brief_for_job", { job: fresh.id }, ctx({ network }))).structuredContent);
    const saved = netJob("00000a03-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const savedNet = offlineNetwork({ getJson: async () => ({ job: saved }), loadSaved: async () => ({ role: toNetRole(saved), brief, at: "" }) });
    matches("get_build_brief", (await call("get_build_brief", { job: saved.id }, ctx({ network: savedNet }))).structuredContent);
  });

  it("brief_from_job_post's result shape matches", async () => {
    const result = await makeBrief("x".repeat(400), {
      hasKey: () => true,
      fetchPost: async () => null,
      generate: async () => ({ ...brief, company: "Acme", title: "Engineer" }),
      save: async () => "abcdefghijkl",
      record: async () => {},
    });
    assert.ok(!("error" in result));
    matches("brief_from_job_post", { brief: result.brief, url: `https://example.test/b/${result.id}` });
    matches("brief_from_job_post", { brief: result.brief, url: null });
  });

  it("rejects a result missing a required field", () => {
    assert.equal(OUTPUT.list_briefs.safeParse({ roles: [] }).success, false);
  });
});
