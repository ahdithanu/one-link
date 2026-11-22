import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_BODY_BYTES, VERSIONS } from "@/lib/mcp-http";
import { call, ctx, raw, rpc } from "./helpers";

describe("lifecycle", () => {
  for (const v of VERSIONS) {
    it(`initialize echoes supported version ${v}`, async () => {
      const r = await rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } });
      assert.equal(r.status, 200);
      assert.equal(r.json.result.protocolVersion, v);
      assert.deepEqual(r.json.result.capabilities, { tools: { listChanged: false } });
      assert.equal(r.json.result.serverInfo.name, "one-link");
      assert.equal(typeof r.json.result.instructions, "string");
    });
  }
  it("initialize offers the latest version for an unknown one", async () => {
    const r = await rpc("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(r.json.result.protocolVersion, VERSIONS[0]);
  });
  it("notifications/initialized is accepted with 202 and no body", async () => {
    const r = await raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    assert.deepEqual(r, { status: 202, body: null });
  });
  it("a JSON-RPC response from the client is accepted with 202", async () => {
    const r = await raw(JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }));
    assert.deepEqual(r, { status: 202, body: null });
  });
  it("ping returns an empty result", async () => {
    const r = await rpc("ping");
    assert.deepEqual(r.json.result, {});
  });
  it("responses echo the request id and jsonrpc 2.0", async () => {
    const r = await rpc("ping");
    assert.equal(r.json.jsonrpc, "2.0");
    assert.equal(r.json.id, r.id);
  });
  it("string ids are echoed", async () => {
    const r = await raw(JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "ping" }));
    assert.equal((r.body as { id: string }).id, "abc");
  });
});

describe("tool discovery", () => {
  it("lists five tools with object input schemas", async () => {
    const { json } = await rpc("tools/list");
    const tools = json.result.tools;
    assert.deepEqual(tools.map((t: { name: string }) => t.name).sort(), ["brief_for_job", "brief_from_job_post", "get_build_brief", "list_briefs", "search_roles"]);
    for (const t of tools) {
      assert.match(t.name, /^[a-z_]{1,64}$/);
      assert.ok(t.description.length > 20);
      assert.equal(t.inputSchema.type, "object");
      assert.equal(typeof t.inputSchema.properties, "object");
      for (const req of t.inputSchema.required ?? []) assert.ok(req in t.inputSchema.properties);
      assert.equal(typeof t.annotations.readOnlyHint, "boolean");
    }
  });
  it("answers the optional list methods with empty lists", async () => {
    assert.deepEqual((await rpc("resources/list")).json.result, { resources: [] });
    assert.deepEqual((await rpc("resources/templates/list")).json.result, { resourceTemplates: [] });
    assert.deepEqual((await rpc("prompts/list")).json.result, { prompts: [] });
  });
});

describe("errors", () => {
  it("unknown method is -32601", async () => {
    const r = await rpc("sampling/createMessage");
    assert.equal(r.json.error?.code, -32601);
  });
  it("invalid JSON is a -32700 parse error with id null and HTTP 400", async () => {
    const r = await raw("{not json");
    assert.equal(r.status, 400);
    assert.deepEqual((r.body as { error: { code: number } }).error.code, -32700);
    assert.equal((r.body as { id: null }).id, null);
  });
  it("empty body is a parse error", async () => {
    assert.equal((await raw("")).status, 400);
  });
  it("batches are rejected with -32600", async () => {
    const r = await raw(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: number } }).error.code, -32600);
  });
  for (const [label, body] of [
    ["missing jsonrpc", { id: 1, method: "ping" }],
    ["wrong jsonrpc", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["non-string method", { jsonrpc: "2.0", id: 1, method: 5 }],
    ["null id", { jsonrpc: "2.0", id: null, method: "ping" }],
    ["object id", { jsonrpc: "2.0", id: { a: 1 }, method: "ping" }],
    ["scalar message", 42],
  ] as const) {
    it(`${label} is -32600 with HTTP 400`, async () => {
      const r = await raw(JSON.stringify(body));
      assert.equal(r.status, 400);
      assert.equal((r.body as { error: { code: number } }).error.code, -32600);
    });
  }
  it("non-object params is -32602", async () => {
    const r = await rpc("tools/list", [1, 2]);
    assert.equal(r.json.error?.code, -32602);
  });
  it("unsupported MCP-Protocol-Version header is HTTP 400", async () => {
    const r = await rpc("ping", undefined, { headers: { "mcp-protocol-version": "2030-01-01" } });
    assert.equal(r.status, 400);
  });
  it("supported MCP-Protocol-Version header is accepted", async () => {
    const r = await rpc("ping", undefined, { headers: { "mcp-protocol-version": "2025-06-18" } });
    assert.equal(r.status, 200);
  });
  it(`bodies over ${MAX_BODY_BYTES} bytes are HTTP 413`, async () => {
    const r = await raw(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MAX_BODY_BYTES) } }));
    assert.equal(r.status, 413);
  });
  it("tools/call without a name is -32602", async () => {
    assert.equal((await rpc("tools/call", {})).json.error?.code, -32602);
  });
  it("tools/call with an unknown tool is -32602", async () => {
    const r = await rpc("tools/call", { name: "delete_everything", arguments: {} });
    assert.equal(r.json.error?.code, -32602);
    assert.match(r.json.error!.message, /Unknown tool/);
  });
  it("tools/call with non-object arguments is -32602", async () => {
    assert.equal((await rpc("tools/call", { name: "list_briefs", arguments: "x" })).json.error?.code, -32602);
  });
  it("an exception inside a tool becomes a generic tool error, never the exception text", async () => {
    const boom = ctx({ limited: () => { throw new Error("SECRET internal detail"); } });
    const res = await call("brief_from_job_post", { job_post: "x".repeat(300) }, boom);
    assert.equal(res.isError, true);
    assert.doesNotMatch(res.content[0].text, /SECRET/);
  });
});
