// Drives One Link with the official MCP TypeScript SDK client: discovery, tool calls, output-schema
// validation (the SDK's callTool validates structuredContent against the tool's outputSchema),
// errors, and progress notifications. The SDK isn't a project dependency, so install it unsaved:
//   npm i --no-save @modelcontextprotocol/sdk@1.32.2
//   node eval/sdk-client-check.mjs http://localhost:3210/mcp
// The progress check needs a role without a brief and a server whose model key is set; with an
// invalid key the call ends in a tool error, but the notifications still arrive first.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.argv[2]);
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

const client = new Client({ name: "one-link-compat", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));
const v = client.getServerVersion();
check("connect + initialize", Boolean(v?.name === "one-link"), JSON.stringify(v));

const { tools } = await client.listTools();
check("tools/list: 5 tools, each with inputSchema and outputSchema", tools.length === 5 && tools.every((t) => t.inputSchema && t.outputSchema), tools.map((t) => t.name).join(","));

const call = async (name, args, opts) => {
  try {
    return await client.callTool({ name, arguments: args }, undefined, opts);
  } catch (e) {
    return { threw: e.message };
  }
};
let r = await call("list_briefs", { limit: 3 });
check("list_briefs: result passes the SDK's outputSchema validation", !r.threw && !r.isError && r.structuredContent?.roles?.length === 3, r.threw ?? "");
const jobId = r.structuredContent?.roles?.[0]?.job_id;
r = await call("get_build_brief", { job: jobId });
check("get_build_brief (speedrun role): validated", !r.threw && !r.isError && r.structuredContent?.brief?.build?.title, r.threw ?? "");
r = await call("search_roles", { q: "designer" });
check("search_roles: validated", !r.threw && !r.isError && r.structuredContent?.roles?.length > 0, r.threw ?? JSON.stringify(r.content?.[0]).slice(0, 120));
r = await call("list_briefs", { limit: 500 });
check("invalid arguments come back as a tool error", r.isError === true && /Invalid arguments/.test(r.content?.[0]?.text ?? ""), r.threw ?? "");
r = await call("get_build_brief", { job: "zzzzzzzz" });
check("bad id: tool error, not a crash", r.isError === true, r.threw ?? "");
r = await call("no_such_tool", {});
check("unknown tool: JSON-RPC error surfaced by the SDK", Boolean(r.threw), r.threw ?? "no throw");

// Progress: brief_for_job on a role without a brief. The local server runs with an invalid model key,
// so the call ends in a tool error, but the phase notifications arrive first.
const search = await call("search_roles", { q: "account executive" });
const fresh = search.structuredContent?.roles?.find((x) => !x.has_brief)?.job_id;
const notes = [];
r = await call("brief_for_job", { job: fresh }, { onprogress: (p) => notes.push(p), resetTimeoutOnProgress: true });
check("progress notifications reach the SDK's onprogress callback", notes.length >= 2 && notes.every((n, i) => i === 0 || n.progress > notes[i - 1].progress), JSON.stringify(notes.map((n) => n.message)));
check("brief_for_job still returns its final result after progress", !r.threw && "content" in r, r.threw ?? "");

await client.close();
for (const x of results) console.log(`${x.ok ? "ok  " : "FAIL"} ${x.name}${x.ok ? "" : `  ${x.detail}`}`);
console.log(results.every((x) => x.ok) ? "\nall SDK client checks passed" : "\nsome checks failed");
