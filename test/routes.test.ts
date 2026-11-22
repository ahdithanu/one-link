import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { POST as briefPOST } from "@/app/api/brief/route";
import { POST as jobBriefPOST } from "@/app/api/job-brief/route";
import { limited } from "@/lib/limit";

const req = (url: string, body: unknown, ip: string, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", "x-real-ip": ip, ...headers } });

describe("/api/brief", () => {
  it("malformed requests never use up the caller's hourly allowance", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    try {
      const ip = "203.0.113.50";
      for (const input of ["", "short", "x".repeat(50), 42]) {
        const res = await briefPOST(req("http://localhost/api/brief", { input }, ip));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, "invalid_arguments");
      }
      const allowance = [];
      for (let i = 0; i < 5; i++) allowance.push(await limited(ip));
      assert.deepEqual(allowance, [false, false, false, false, false], "all 5 briefs still available");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("refuses an oversized body before reading it", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    try {
      const res = await briefPOST(req("http://localhost/api/brief", { input: "x" }, "203.0.113.51", { "content-length": String(1024 * 1024) }));
      assert.equal(res.status, 413);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("returns a code with every error so the page can react", async () => {
    const res = await briefPOST(req("http://localhost/api/brief", { input: "https://example.com/job" }, "203.0.113.52"));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "model_unavailable");
  });
});

describe("/api/job-brief", () => {
  it("unknown ids are a 404 with a code, before any limit or model", async () => {
    const res = await jobBriefPOST(req("http://localhost/api/job-brief", { id: "not-a-job" }, "203.0.113.53"));
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "not_found");
  });
});
