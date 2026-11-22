import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Brief } from "@/lib/data";
import { progressToken, streamMcp } from "@/lib/mcp-http";
import { ctx, offlineNetwork } from "./helpers";

const H = (extra: Record<string, string> = {}) => new Headers({ host: "localhost:3210", accept: "application/json, text/event-stream", ...extra });
const call = (name: string, args: unknown, meta?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args, ...(meta !== undefined && { _meta: meta }) } });

async function events(stream: ReadableStream<Uint8Array>) {
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      assert.match(block, /^event: message\ndata: /);
      return JSON.parse(block.replace(/^event: message\ndata: /, ""));
    });
}

describe("which requests get progress", () => {
  it("only slow tools, only with a token, only if the client accepts SSE", () => {
    const id = "00000c01-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    assert.equal(progressToken(call("brief_for_job", { job: id }, { progressToken: "t1" }), H()), "t1");
    assert.equal(progressToken(call("brief_for_job", { job: id }, { progressToken: 9 }), H()), 9);
    assert.equal(progressToken(call("brief_for_job", { job: id }), H()), null, "no token");
    assert.equal(progressToken(call("list_briefs", {}, { progressToken: "t" }), H()), null, "fast tool");
    assert.equal(progressToken(call("brief_for_job", { job: id }, { progressToken: "t" }), H({ accept: "application/json" })), null, "no SSE accept");
    assert.equal(progressToken(call("brief_for_job", { job: id }, { progressToken: "t" }), H({ host: "evil.example" })), null, "bad host keeps its 403");
    assert.equal(progressToken(call("brief_for_job", { job: id }, { progressToken: "t" }), H({ "mcp-protocol-version": "1999-01-01" })), null, "bad version keeps its 400");
    assert.equal(progressToken("{nope", H()), null);
  });
});

describe("progress stream", () => {
  it("sends phase notifications with increasing progress, then the response with the request's id", async () => {
    const brief: Brief = {
      need: "n", evidence: "", build: { title: "Backfill checker", pitch: "p" },
      plan: [{ when: "Saturday morning", do: "a" }, { when: "Saturday afternoon", do: "b" }, { when: "Sunday", do: "c" }],
      good: ["x", "y", "z"], avoid: "a", opener: "o",
    };
    const job = {
      id: "00000c02-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Engineer", company: "Acme", url: "https://x", location: null, workplace_type: null,
      function: "engineering", comp_min: null, comp_max: null, published_at: "2026-11-01T00:00:00Z", stealth: false, status: "open", tier: "a16z",
      description_text: "We need someone to build reliable data pipelines for logistics customers. ".repeat(6),
    };
    const network = offlineNetwork({
      hasKey: () => true,
      getJson: async () => ({ job }),
      generate: async () => (await new Promise((r) => setTimeout(r, 60)), brief),
    });
    const out = await events(streamMcp(call("brief_for_job", { job: job.id }, { progressToken: "tok" }), H(), ctx({ network }), "tok", 20));
    const notes = out.filter((e) => e.method === "notifications/progress");
    const final = out.at(-1);
    assert.ok(notes.length >= 3, `expected phases and heartbeats, got ${notes.length}`);
    assert.ok(notes.every((n) => n.params.progressToken === "tok"));
    const progress = notes.map((n) => n.params.progress);
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
    assert.equal(new Set(progress).size, progress.length, "progress strictly increases");
    assert.ok(notes.some((n) => /Looking up the role/.test(n.params.message)));
    assert.ok(notes.some((n) => /Writing the brief/.test(n.params.message)));
    assert.equal(final.id, 7);
    assert.equal(final.result.structuredContent.brief.build.title, "Backfill checker");
  });
});
