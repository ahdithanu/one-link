// Runs the official MCP conformance suite against a running server and fails if any scenario that
// applies to a tools-only server stops passing. Scenarios for features One Link doesn't offer
// (resources/read, prompts/get, the suite's own fixture tools, sampling, elicitation, logging) are
// expected to fail and are listed for the record.
// Usage: node scripts/check-conformance.mjs http://localhost:3210/mcp
import { execFileSync } from "node:child_process";

const url = process.argv[2] ?? "http://localhost:3210/mcp";
const REQUIRED = ["server-initialize", "ping", "tools-list", "resources-list", "prompts-list", "dns-rebinding-protection"];

let out = "";
try {
  out = execFileSync("npx", ["-y", "@modelcontextprotocol/conformance@0.1.16", "server", "--url", url, "--suite", "all"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
} catch (err) {
  out = `${err.stdout ?? ""}${err.stderr ?? ""}`; // the suite exits non-zero because of the N/A scenarios
}
const results = new Map();
for (const line of out.split("\n")) {
  const m = line.match(/^\s*([✓✗])\s+([a-z0-9-]+):/);
  if (m) results.set(m[2], m[1] === "✓");
}
const missing = REQUIRED.filter((s) => !results.has(s));
const failing = REQUIRED.filter((s) => results.get(s) === false);
console.log(`conformance: ${[...results.values()].filter(Boolean).length} passed, ${[...results.values()].filter((v) => !v).length} not applicable or failed`);
for (const s of REQUIRED) console.log(`  ${results.get(s) ? "pass" : "FAIL"} ${s}`);
if (missing.length || failing.length) {
  console.error(`required scenarios failing: ${[...failing, ...missing].join(", ")}`);
  process.exit(1);
}
