// Freezes a fixed set of public speedrun job posts into eval/dataset/posts.json so model evals
// run on the same inputs every time. Run once; re-running replaces the snapshot.
import { writeFileSync } from "node:fs";

const API = "https://speedrun-talent-network.com/api/v1";
const IDS = ["75f50699", "1ad47635", "b39315d9", "bfe9c173", "42e59477", "2a058d3a", "ea2dfc8a", "ccb4620a", "afe9efe4", "7d1fe5bc", "128d7ee4"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The public API sits behind Cloudflare, which rate-limits bursts (error 1015). Go slowly and back off.
async function getJson(url: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "one-link-eval", accept: "application/json" } });
    const body = await res.text();
    if (res.ok && body.startsWith("{")) return JSON.parse(body);
    await sleep(15_000 * (attempt + 1));
  }
  throw new Error(`gave up on ${url}`);
}

const list = await getJson(`${API}/jobs?scope=speedrun&page=0&source=one-link`);
const posts = [];
for (const short of IDS) {
  const hit = list.jobs.find((j: { id: string }) => j.id.startsWith(short));
  if (!hit) throw new Error(`${short} is no longer listed; pick another id`);
  await sleep(2000);
  const data = await getJson(`${API}/jobs/${hit.id}?source=one-link`);
  const job = data.job ?? data;
  posts.push({
    id: short,
    kind: "real",
    function: job.function ?? "other",
    company: job.company,
    title: job.title.trim(),
    source: job.url,
    post: job.description_text,
  });
}
writeFileSync("eval/dataset/posts.json", JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), posts }, null, 2) + "\n");
console.log(`saved ${posts.length} posts`, posts.map((p) => `${p.id} ${p.post.length}`).join(", "));
