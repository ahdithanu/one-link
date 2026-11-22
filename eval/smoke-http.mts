// Black-box protocol checks over real HTTP against a running server.
// Usage: npx tsx eval/smoke-http.mts [url] [--live]   (default http://localhost:3210/mcp)
// --live adds checks that need the real talent network API (search_roles, the home page). The
// scheduled production monitor uses it; CI doesn't, so CI never depends on an outside API.
// Read-only: it never writes a brief or a usage event, so it is safe to run against production.
const URL_ = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3210/mcp";
const LIVE = process.argv.includes("--live");
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};
const post = (body: string, headers: Record<string, string> = {}) => fetch(URL_, { method: "POST", headers: { ...H, ...headers }, body });

let r = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }));
let j = await r.json();
check("initialize 200 + negotiated version", r.status === 200 && j.result?.protocolVersion === "2025-06-18", JSON.stringify(j).slice(0, 200));
check("json content type", (r.headers.get("content-type") ?? "").includes("application/json"));
check("CORS allow-origin", r.headers.get("access-control-allow-origin") === "*");

r = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), { "mcp-protocol-version": "2025-06-18" });
check("notification -> 202 empty", r.status === 202 && (await r.text()) === "");

r = await post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), { "mcp-protocol-version": "2025-06-18" });
j = await r.json();
check("tools/list returns 5 tools", j.result?.tools?.length === 5, JSON.stringify(j).slice(0, 200));

r = await post(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_briefs", arguments: { limit: 2 } } }));
j = await r.json();
check("list_briefs works", !j.result?.isError && j.result?.structuredContent?.roles?.length === 2, JSON.stringify(j).slice(0, 200));

r = await post(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_briefs", arguments: { limit: 500 } } }));
j = await r.json();
check("invalid argument -> isError", j.result?.isError === true, JSON.stringify(j).slice(0, 200));

r = await post("{oops");
j = await r.json().catch(() => ({}));
check("parse error -> 400 -32700", r.status === 400 && j.error?.code === -32700, `${r.status} ${JSON.stringify(j)}`);

r = await post(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }), { "mcp-protocol-version": "1999-01-01" });
check("unsupported protocol header -> 400", r.status === 400, String(r.status));

r = await post(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping", params: { pad: "x".repeat(200_000) } }));
check("oversized body -> 413", r.status === 413, String(r.status));

r = await post(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "nope" }));
j = await r.json();
check("unknown method -> -32601", j.error?.code === -32601);

r = await fetch(URL_, { method: "GET", headers: { accept: "text/event-stream" } });
check("GET (no SSE stream) -> 405", r.status === 405, String(r.status));

r = await fetch(URL_, { method: "OPTIONS" });
check("OPTIONS preflight -> 204", r.status === 204, String(r.status));

if (LIVE) {
  let t0 = Date.now();
  r = await post(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "search_roles", arguments: { q: "engineer" } } }));
  j = await r.json();
  check(`search_roles reaches the talent network (${Date.now() - t0} ms)`, !j.result?.isError && j.result?.structuredContent?.roles?.length > 0, JSON.stringify(j).slice(0, 200));
  t0 = Date.now();
  r = await fetch(new URL("/", URL_));
  check(`home page 200 (${Date.now() - t0} ms)`, r.status === 200, String(r.status));
}

console.log(failed ? `\n${failed} check(s) failed against ${URL_}` : `\nall checks passed against ${URL_}`);
process.exit(failed ? 1 : 0);
