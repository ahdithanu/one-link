// Freezes a sample of non-speedrun roles from the talent network for the quality eval: one role per
// function, from companies outside the speedrun portfolio, with a real description. Read-only,
// paced at one request every 2 s to respect the API. Usage: npx tsx eval/build-external.mts
import { writeFileSync } from "node:fs";

const API = "https://speedrun-talent-network.com/api/v1";
const FUNCTIONS = ["engineering", "product", "design", "sales", "marketing", "operations", "finance", "customer", "research", "hardware_manufacturing"];
const pause = () => new Promise((r) => setTimeout(r, 2000));
async function get(url: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "one-link-eval" } });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) await new Promise((r) => setTimeout(r, 15_000 * attempt));
    else throw new Error(`${res.status} ${url}`);
  }
  throw new Error(`gave up on ${url}`);
}

const posts = [];
for (const fn of FUNCTIONS) {
  const list = await get(`${API}/jobs?scope=all&fn=${fn}&page=1&source=one-link-eval`);
  await pause();
  for (const j of list.jobs ?? []) {
    if (j.tier === "speedrun" || j.stealth) continue;
    const { job } = await get(`${API}/jobs/${j.id}?source=one-link-eval`);
    await pause();
    const post = job?.description_text ?? "";
    if (job?.status !== "open" || post.length < 1200 || post.length > 15_000) continue;
    posts.push({ id: `ext-${fn}`, function: fn, tier: job.tier, company: job.company, title: job.title.trim(), url: job.url.split("?")[0], post });
    console.log(`${fn.padEnd(22)} ${job.company} · ${job.title.trim()} (${post.length} chars)`);
    break;
  }
}
writeFileSync(
  "eval/dataset/external.json",
  JSON.stringify({ fetched_at: new Date().toISOString().slice(0, 10), source: `${API}/jobs (scope=all, non-speedrun companies)`, posts }, null, 2) + "\n",
);
console.log(`wrote ${posts.length} roles`);
