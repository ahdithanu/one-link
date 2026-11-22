import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLines, report } from "@/lib/metrics";

const L = (o: object) => JSON.stringify(o);
const fixture = [
  L({ event: "mcp_request", method: "tools/call", tool: "brief_for_job", ok: true, status: 200, duration_ms: 12000, usage: { model: "m", input_tokens: 2000, output_tokens: 1000 } }),
  L({ event: "mcp_request", method: "tools/call", tool: "brief_for_job", ok: false, status: 200, error_category: "rate_limited", duration_ms: 5 }),
  L({ event: "mcp_request", method: "tools/call", tool: "search_roles", ok: true, status: 200, duration_ms: 300 }),
  L({ event: "mcp_request", method: "tools/call", tool: "search_roles", ok: true, status: 200, duration_ms: 900 }),
  L({ event: "mcp_request", method: "initialize", ok: true, status: 200, duration_ms: 2 }),
  JSON.stringify({ message: L({ event: "web_request", method: "/api/brief", ok: false, status: 502, error_category: "model_error", duration_ms: 45000 }) }),
  L({ event: "talent_api", op: "search", ok: true, status: 200, attempts: 1, duration_ms: 400, breaker: "closed" }),
  L({ event: "talent_api", op: "search", ok: false, status: 503, attempts: 2, duration_ms: 8000, breaker: "closed" }),
  L({ event: "talent_api_breaker", from: "closed", to: "open" }),
  L({ event: "rate_limit_fallback", detail: "x" }),
  "not json at all",
  L({ unrelated: true }),
].join("\n");

describe("log metrics", () => {
  const r = report(parseLines(fixture));
  it("reads raw and wrapped lines, ignores everything else", () => {
    assert.equal(r.window.lines, 10);
    assert.equal(r.window.requests, 6);
  });
  it("per-tool success rate and latency percentiles", () => {
    assert.deepEqual(r.tools.search_roles, { calls: 2, success_rate: 100, p50_ms: 300, p95_ms: 900 });
    assert.equal(r.tools.brief_for_job.success_rate, 50);
  });
  it("generation success, failures, rejections and spend", () => {
    assert.deepEqual(r.brief_generation, { attempts: 3, success_rate: 33.3, model_calls: 1 });
    assert.equal(r.model_failures.model_error, 1);
    assert.equal(r.rate_limit_rejections, 1);
    assert.deepEqual(r.model_spend, { input_tokens: 2000, output_tokens: 1000, usd: 0.03 });
  });
  it("talent API health, breaker opens and Redis fallbacks", () => {
    assert.deepEqual(r.talent_api, { calls: 2, failure_rate: 50, p50_ms: 400, p95_ms: 8000, breaker_opens: 1 });
    assert.equal(r.redis_fallbacks, 1);
    assert.equal(r.mcp_availability, 100);
  });
});
