import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import type { GeneratedBrief } from "@/lib/brief";
import { FetchBlocked } from "@/lib/fetch-post";
import { makeBrief, type MakeBriefDeps } from "@/lib/make-brief";

const brief: GeneratedBrief = {
  company: "Acme",
  title: "Engineer",
  need: "n",
  evidence: "e",
  build: { title: "A thing", pitch: "p" },
  plan: [{ when: "Saturday morning", do: "x" }],
  good: ["g"],
  avoid: "a",
  opener: "o [your link]",
};
const POST = "We are hiring. ".repeat(20);
const usage = { model: "m", input_tokens: 10, output_tokens: 5 };

const deps = (over: Partial<MakeBriefDeps> = {}): MakeBriefDeps => ({
  hasKey: () => true,
  fetchPost: async () => POST,
  generate: async (_post, onUsage) => (onUsage(usage), brief),
  save: async () => "abcdefghijkl",
  record: async () => {},
  ...over,
});

describe("makeBrief", () => {
  it("succeeds, saves, and passes usage through", async () => {
    assert.deepEqual(await makeBrief(POST, deps()), { brief, id: "abcdefghijkl", usage });
  });
  it("still returns the brief when saving fails", async () => {
    const r = await makeBrief(POST, deps({ save: async () => { throw new Error("blob down"); } }));
    assert.ok("brief" in r && r.id === null);
  });
  const cases: [string, unknown, Partial<MakeBriefDeps>, number, string][] = [
    ["no API key", POST, { hasKey: () => false }, 503, "model_unavailable"],
    ["non-string input", 42, {}, 400, "invalid_arguments"],
    ["under 12 characters", "hello", {}, 400, "invalid_arguments"],
    ["over 20000 characters", "x".repeat(20001), {}, 400, "invalid_arguments"],
    ["a description under 200 characters", "Engineer at Acme, apply now please.", {}, 400, "invalid_arguments"],
    ["a url that won't load", "https://example.com/job", { fetchPost: async () => null }, 422, "fetch_failed"],
    ["a url that throws", "https://example.com/job", { fetchPost: async () => { throw new Error("ECONNRESET"); } }, 422, "fetch_failed"],
    ["a blocked url", "https://10.0.0.1/job", { fetchPost: async () => { throw new FetchBlocked("blocked host"); } }, 422, "fetch_failed"],
    ["text that isn't a job post", POST, { generate: async () => null }, 422, "not_a_job_post"],
    ["a model rate limit", POST, { generate: async () => { throw new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()); } }, 503, "model_rate_limited"],
    ["a model server error", POST, { generate: async () => { throw new Anthropic.InternalServerError(500, undefined, "oops", new Headers()); } }, 502, "model_error"],
    ["a model timeout", POST, { generate: async () => { throw new Anthropic.APIConnectionTimeoutError(); } }, 502, "model_error"],
  ];
  for (const [label, input, over, status, category] of cases) {
    it(`maps ${label} to ${status} ${category}`, async () => {
      const r = await makeBrief(input, deps(over));
      assert.ok("error" in r, "expected an error");
      assert.equal(r.status, status);
      assert.equal(r.category, category);
    });
  }
  it("rethrows unexpected errors for the caller to handle", async () => {
    await assert.rejects(makeBrief(POST, deps({ generate: async () => { throw new TypeError("bug"); } })), TypeError);
  });
  it("only fetches when the whole input is one url", async () => {
    let fetched = false;
    await makeBrief(`${POST} see https://example.com`, deps({ fetchPost: async () => ((fetched = true), POST) }));
    assert.equal(fetched, false);
  });
});
