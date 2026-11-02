import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [outDir, jobsDir] = process.argv.slice(2);
const roles = JSON.parse(readFileSync("data/roles.json", "utf8")).roles;
const descriptions = new Map();
for (const f of readdirSync(jobsDir)) {
  const d = JSON.parse(readFileSync(join(jobsDir, f), "utf8"));
  const job = d.job ?? d;
  descriptions.set(job.id, job.description_text ?? "");
}

const briefs = {};
for (const f of readdirSync(outDir).filter((n) => n.endsWith(".json"))) {
  for (const b of JSON.parse(readFileSync(join(outDir, f), "utf8"))) briefs[b.id] = b;
}

const banned = /leverage|seamless|robust|passionate|—/i;
const problems = [];
const seenBuilds = new Map();
for (const r of roles) {
  const b = briefs[r.id];
  if (!b) { problems.push([r.id, "missing"]); continue; }
  const add = (m) => problems.push([r.id, `${r.company}: ${m}`]);
  if (!descriptions.get(r.id).includes(b.evidence)) add(`evidence not in post: ${b.evidence}`);
  if (b.evidence.split(/\s+/).length > 15) add("evidence over 15 words");
  if (!b.build?.title || b.build.title.split(/\s+/).length > 8) add(`build title length: ${b.build?.title}`);
  if (b.plan?.length !== 3) add("plan needs 3 steps");
  if (b.good?.length !== 3) add("good needs 3 items");
  if (!b.opener?.endsWith("[your link]") && !b.opener?.includes("[your link]")) add("opener missing [your link]");
  if ((b.opener ?? "").split(/\s+/).length > 34) add("opener too long");
  if (banned.test(JSON.stringify(b))) add(`banned wording: ${JSON.stringify(b).match(banned)[0]}`);
  const key = `${r.company}|${b.build?.title}`;
  if (seenBuilds.has(key)) add(`duplicate build title: ${b.build?.title}`);
  seenBuilds.set(key, r.id);
}

for (const [id, m] of problems) console.log(id.slice(0, 8), m);
console.log(`${Object.keys(briefs).length} briefs, ${roles.length} roles, ${problems.length} problems`);
const clean = Object.fromEntries(roles.filter((r) => briefs[r.id]).map((r) => {
  const { id, ...rest } = briefs[r.id];
  return [r.id, rest];
}));
writeFileSync("data/briefs.json", JSON.stringify(clean));
