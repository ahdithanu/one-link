// Deterministic evaluation of the MCP tools against the bundled board. No network, no model.
// Usage: npx tsx eval/tools.mts   (writes eval/results/tools.json)
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";

process.env.ONE_LINK_LOG = "off";
delete process.env.BLOB_READ_WRITE_TOKEN;
const { bundled } = await import("../lib/data");
const { handleMcp } = await import("../lib/mcp-http");

const ctx = { origin: "https://eval.test", limited: () => false, eventLimited: () => true };
let id = 0;
async function call(name: string, args: Record<string, unknown>) {
  const res = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }), new Headers({ host: "localhost" }), ctx);
  return (res.body as { result: { content: { text: string }[]; structuredContent?: any; isError?: boolean } }).result;
}

const StoredBrief = z.object({
  need: z.string().min(1),
  evidence: z.string(),
  build: z.object({ title: z.string().min(1), pitch: z.string().min(1) }),
  plan: z.array(z.object({ when: z.string(), do: z.string().min(1) })).length(3),
  good: z.array(z.string().min(1)).length(3),
  avoid: z.string().min(1),
  opener: z.string().min(1),
});
const WHENS = ["Saturday morning", "Saturday afternoon", "Sunday"];
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

type Check = { tool: string; check: string; subject: string; pass: boolean; detail?: string };
const checks: Check[] = [];
const record = (tool: string, check: string, subject: string, pass: boolean, detail?: string) => checks.push({ tool, check, subject, pass, ...(detail && !pass && { detail }) });

const open = bundled.roles.filter((r) => r.open !== false && bundled.briefs[r.id]);

for (const role of open) {
  for (const [form, job] of [["uuid", role.id], ["short", role.short], ["url", role.url]] as const) {
    const res = await call("get_build_brief", { job });
    record("get_build_brief", `resolves_${form}`, role.short, !res.isError && res.structuredContent?.role.id === role.id, res.content[0].text.slice(0, 120));
  }
  const res = await call("get_build_brief", { job: role.id });
  const brief = res.structuredContent?.brief;
  const parsed = StoredBrief.safeParse(brief);
  record("get_build_brief", "output_schema", role.short, parsed.success, parsed.success ? undefined : parsed.error.issues.map((i) => i.path.join(".")).join(","));
  if (!parsed.success) continue;
  const b = parsed.data;
  record("get_build_brief", "source_consistency", role.short, JSON.stringify(b) === JSON.stringify(bundled.briefs[role.id]));
  record("get_build_brief", "plan_days", role.short, b.plan.every((p, i) => p.when === WHENS[i]), b.plan.map((p) => p.when).join("|"));
  record("get_build_brief", "build_title_max_8_words", role.short, words(b.build.title) <= 8, b.build.title);
  record("get_build_brief", "evidence_max_15_words", role.short, words(b.evidence) <= 15, b.evidence);
  record("get_build_brief", "opener_has_link_slot", role.short, b.opener.includes("[your link]"), b.opener);
  record("get_build_brief", "opener_max_34_words", role.short, words(b.opener) <= 34, String(words(b.opener)));
  record("get_build_brief", "no_em_dash", role.short, !JSON.stringify(b).includes("—"));
  record("get_build_brief", "age_and_pay_shown", role.short, /Posted: \d+ days ago/.test(res.content[0].text) && /Pay: /.test(res.content[0].text));
}

const missing = ["00000000", "ffffffff", "deadbeef-0000-0000-0000-000000000000"];
for (const job of missing) {
  const res = await call("get_build_brief", { job });
  record("get_build_brief", "missing_record_is_tool_error", job, res.isError === true && /brief_from_job_post/.test(res.content[0].text));
}
for (const job of ["hello world!", "", 42, null, "x".repeat(301)]) {
  const res = await call("get_build_brief", { job });
  record("get_build_brief", "invalid_id_is_tool_error", JSON.stringify(job).slice(0, 20), res.isError === true);
}

const all = await call("list_briefs", { limit: 50 });
record("list_briefs", "total_matches_board", "all", all.structuredContent.total === open.length, `${all.structuredContent.total} vs ${open.length}`);
for (const row of all.structuredContent.roles) {
  const res = await call("get_build_brief", { job: row.job_id });
  record("list_briefs", "row_resolves_to_same_build", row.job_id.slice(0, 8), res.structuredContent?.brief.build.title === row.build);
}
const fns = [...new Set(open.map((r) => r.function))];
for (const fn of fns) {
  const res = await call("list_briefs", { function: fn, limit: 50 });
  const expected = open.filter((r) => r.function === fn).length;
  record("list_briefs", "function_filter_exact", fn, res.structuredContent.total === expected && res.structuredContent.roles.every((r: { function: string }) => r.function === fn), `${res.structuredContent.total} vs ${expected}`);
}
for (const company of [...new Set(open.map((r) => r.company))].slice(0, 10)) {
  const res = await call("list_briefs", { q: company, limit: 50 });
  const expected = open.filter((r) => `${r.title} ${r.company} ${bundled.briefs[r.id].build.title}`.toLowerCase().includes(company.toLowerCase())).length;
  record("list_briefs", "text_filter_exact", company, res.structuredContent.total === expected, `${res.structuredContent.total} vs ${expected}`);
}
const empty = await call("list_briefs", { q: "no-such-role-xyz" });
record("list_briefs", "empty_result_not_error", "no-such-role-xyz", !empty.isError && empty.structuredContent.total === 0);
for (const limit of [1, 7, 50]) {
  const res = await call("list_briefs", { limit });
  record("list_briefs", "limit_respected", String(limit), res.structuredContent.roles.length === Math.min(limit, open.length));
}
for (const args of [{ limit: 0 }, { limit: 51 }, { limit: "5" }, { function: "astrology" }, { q: "x".repeat(121) }]) {
  const res = await call("list_briefs", args);
  record("list_briefs", "invalid_params_are_tool_errors", JSON.stringify(args).slice(0, 30), res.isError === true);
}

// Summary
const groups = new Map<string, { pass: number; fail: number; failures: string[] }>();
for (const c of checks) {
  const key = `${c.tool}.${c.check}`;
  const g = groups.get(key) ?? { pass: 0, fail: 0, failures: [] };
  if (c.pass) g.pass++;
  else {
    g.fail++;
    g.failures.push(`${c.subject}${c.detail ? `: ${c.detail}` : ""}`);
  }
  groups.set(key, g);
}
const passed = checks.filter((c) => c.pass).length;
const summary = {
  ran_at: new Date().toISOString(),
  board_as_of: bundled.asOf,
  open_roles: open.length,
  total_checks: checks.length,
  passed,
  failed: checks.length - passed,
  pass_rate: +(passed / checks.length).toFixed(4),
  by_check: Object.fromEntries([...groups].map(([k, g]) => [k, { pass: g.pass, fail: g.fail, failures: g.failures.slice(0, 10) }])),
};
mkdirSync("eval/results", { recursive: true });
writeFileSync("eval/results/tools.json", JSON.stringify(summary, null, 2) + "\n");
console.log(`tool eval: ${passed}/${checks.length} checks passed (${(summary.pass_rate * 100).toFixed(2)}%) over ${open.length} open roles`);
for (const [k, g] of groups) if (g.fail) console.log(`  FAIL ${k}: ${g.fail} (${g.failures.slice(0, 3).join(" | ")})`);
if (process.argv.includes("--strict") && passed !== checks.length) process.exit(1);
