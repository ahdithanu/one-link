// Latency benchmark for the MCP endpoint. Sequential requests, one at a time.
// Usage: npx tsx eval/bench.mts <url> [--n 50] [--label local|production] [--with-brief]
// --with-brief adds get_build_brief, which records a usage event; leave it off against production.
const url = process.argv[2] ?? "http://localhost:3210/mcp";
const arg = (name: string, d: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : d);
const N = Number(arg("--n", "50"));
const label = arg("--label", url.includes("localhost") ? "local" : "remote");
const withBrief = process.argv.includes("--with-brief");

const ops: Record<string, unknown> = {
  initialize: { method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "1" } } },
  "tools/list": { method: "tools/list" },
  "list_briefs (limit 20)": { method: "tools/call", params: { name: "list_briefs", arguments: {} } },
  "list_briefs (q filter)": { method: "tools/call", params: { name: "list_briefs", arguments: { q: "engineer", limit: 50 } } },
};
if (withBrief) ops["get_build_brief"] = { method: "tools/call", params: { name: "get_build_brief", arguments: { job: "044b247c" } } };

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: s.length, median: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};

console.log(`benchmark: ${label} ${url}, ${N} sequential requests per operation, ${new Date().toISOString()}`);
const results: Record<string, unknown> = {};
for (const [name, body] of Object.entries(ops)) {
  const times: number[] = [];
  let errors = 0;
  for (let i = 0; i < N + 3; i++) {
    const t0 = performance.now();
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: i, ...(body as object) }) });
    const json = await res.json();
    const ms = performance.now() - t0;
    if (!res.ok || json.error || json.result?.isError) errors++;
    if (i >= 3) times.push(ms); // first 3 are warm-up
  }
  results[name] = { ...stats(times), errors };
  const r = results[name] as ReturnType<typeof stats> & { errors: number };
  console.log(`${name.padEnd(24)} median ${String(r.median).padStart(7)}ms  p95 ${String(r.p95).padStart(7)}ms  max ${String(r.max).padStart(7)}ms  errors ${errors}`);
}
if (process.argv.includes("--json")) console.log(JSON.stringify({ label, url, n: N, at: new Date().toISOString(), results }));
