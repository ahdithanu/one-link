import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpUsage } from "@/lib/usage";
import { cleanClient, fields, toDay } from "@/lib/usage";
import { keyMatches, sessionValid, sessionValue, statsKey } from "@/lib/stats-auth";
import { ctx, rpc } from "./helpers";

describe("usage counting", () => {
  it("counts tool calls by tool, and failures separately", () => {
    assert.deepEqual(fields({ method: "tools/call", tool: "search_roles", ok: true }), ["method:tools/call", "calls", "tool:search_roles"]);
    assert.deepEqual(fields({ method: "tools/call", tool: "brief_for_job", ok: false }), [
      "method:tools/call",
      "calls",
      "tool:brief_for_job",
      "errors",
      "tool:brief_for_job:err",
    ]);
  });

  it("buckets unknown tool names and long methods so callers can't mint fields", () => {
    assert.ok(fields({ method: "tools/call", tool: "x".repeat(500), ok: false }).includes("tool:other"));
    assert.deepEqual(fields({ method: "m".repeat(41), ok: false }), ["method:other"]);
  });

  it("counts connections by a cleaned client name", () => {
    assert.deepEqual(fields({ method: "initialize", ok: true, client: "Claude-Code" }), ["method:initialize", "connects", "client:claude-code"]);
    assert.deepEqual(fields({ method: "initialize", ok: true }), ["method:initialize", "connects", "client:unknown"]);
    assert.equal(cleanClient("<script>alert(1)</script>"), "scriptalert1script");
    assert.equal(cleanClient("a".repeat(100))!.length, 40);
    assert.equal(cleanClient("   "), undefined);
    assert.equal(cleanClient(42), undefined);
  });

  it("reads a day's hash into totals, tools and clients", () => {
    const d = toDay("2026-11-24", { calls: "4", errors: "1", connects: "2", "tool:search_roles": "3", "tool:get_build_brief": "1", "tool:get_build_brief:err": "1", "client:cursor": "2", "method:tools/call": "4" }, 3, 2);
    assert.deepEqual(d, {
      day: "2026-11-24",
      callers: 3,
      toolCallers: 2,
      calls: 4,
      errors: 1,
      connects: 2,
      tools: { search_roles: 3, get_build_brief: 1 },
      clients: { cursor: 2 },
    });
    assert.equal(toDay("2026-11-24", null, 0, 0).calls, 0);
  });
});

describe("the MCP handler reports each request for usage", () => {
  const seen = () => {
    const out: McpUsage[] = [];
    return { out, c: ctx({ record: (u) => out.push(u) }) };
  };

  it("passes the client name from initialize", async () => {
    const { out, c } = seen();
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } }, { ctx: c });
    assert.deepEqual(out, [{ method: "initialize", ok: true, client: "claude-code" }]);
  });

  it("passes the tool and outcome of a tool call", async () => {
    const { out, c } = seen();
    await rpc("tools/call", { name: "list_briefs", arguments: {} }, { ctx: c });
    await rpc("tools/call", { name: "get_build_brief", arguments: {} }, { ctx: c });
    assert.deepEqual(out, [
      { method: "tools/call", tool: "list_briefs", ok: true },
      { method: "tools/call", tool: "get_build_brief", ok: false },
    ]);
  });

  it("doesn't count requests the protocol gates reject", async () => {
    const { out, c } = seen();
    await rpc("tools/list", undefined, { ctx: c, headers: { host: "evil.example" } });
    await rpc("tools/list", undefined, { ctx: c, headers: { "mcp-protocol-version": "1999-01-01" } });
    assert.deepEqual(out, []);
  });
});

describe("stats page key", () => {
  it("is off unless STATS_KEY is at least 16 characters", () => {
    assert.equal(statsKey({}), null);
    assert.equal(statsKey({ STATS_KEY: "short" }), null);
    assert.equal(statsKey({ STATS_KEY: "k".repeat(16) }), "k".repeat(16));
  });

  it("accepts only the right key, and the cookie never holds the key", () => {
    const key = "correct-horse-battery";
    assert.ok(keyMatches(key, key));
    assert.ok(!keyMatches("wrong-horse-battery", key));
    assert.ok(!keyMatches(undefined, key));
    assert.ok(!sessionValue(key).includes(key));
    assert.ok(sessionValid(sessionValue(key), key));
    assert.ok(!sessionValid(sessionValue("other-key-0123456789"), key));
    assert.ok(!sessionValid(undefined, key));
  });
});
