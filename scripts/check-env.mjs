// Checks that the Vercel production environment has every variable One Link needs, by name only.
// Values are never read or printed. Usage: node scripts/check-env.mjs [production|preview]
import { execFileSync } from "node:child_process";

const target = process.argv[2] ?? "production";
const REQUIRED = {
  ANTHROPIC_API_KEY: "writing new briefs",
  BLOB_READ_WRITE_TOKEN: "the board, saved briefs and usage counts",
  CRON_SECRET: "protecting the daily refresh",
};
// Either pair turns on global rate limits and the brief lock.
const REDIS_PAIRS = [
  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
];
const OPTIONAL = { DAILY_BRIEF_CAP: "defaults to 100", MCP_ALLOWED_HOSTS: "only needed for a custom domain", STATS_KEY: "turns on the private /stats page (16+ characters)" };

let listing;
try {
  listing = execFileSync("vercel", ["env", "ls", target], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (err) {
  console.error(`Couldn't list Vercel env vars (is the CLI logged in and linked?): ${err.message.split("\n")[0]}`);
  process.exit(2);
}
const names = new Set(listing.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((n) => /^[A-Z][A-Z0-9_]+$/.test(n)));
let missing = 0;
for (const [name, why] of Object.entries(REQUIRED)) {
  const ok = names.has(name);
  if (!ok) missing++;
  console.log(`${ok ? "ok     " : "MISSING"} ${name}  (${why})`);
}
const redis = REDIS_PAIRS.find(([a, b]) => names.has(a) && names.has(b));
console.log(`${redis ? "ok     " : "MISSING"} Redis (${redis ? redis.join(" + ") : "UPSTASH_REDIS_REST_* or KV_REST_API_*"})  (global rate limits and the brief lock; without it they're per instance)`);
for (const [name, why] of Object.entries(OPTIONAL)) console.log(`${names.has(name) ? "set    " : "unset  "} ${name}  (${why})`);
if (missing) process.exit(1);
