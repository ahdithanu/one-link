// Writes a short markdown report from a model-eval results file.
// Usage: npx tsx eval/quality-report.mts eval/results/model-<date>.json > eval/results/quality-report.md
import { readFileSync } from "node:fs";
import { DIMENSION_NAMES } from "./quality";

const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const cfgs = Object.keys(r.summary);
const lines: string[] = [];
lines.push(`# Brief quality report${r.dry_run ? " (DRY RUN: stub models, not real results)" : ""}`, "");
lines.push(`Run ${r.ran_at.slice(0, 10)} · rubric ${r.rubric_version} · dataset ${r.dataset.hash} (${r.dataset.speedrun} speedrun, ${r.dataset.external} external, ${r.dataset.adversarial} adversarial) · judge ${r.judge_model} · ${r.runs_per_case} run(s) per case`, "");
lines.push("Judge scores are a model's estimates on a 1 to 5 scale. Deterministic checks are exact.", "");
lines.push("## Deterministic checks", "", `| | ${cfgs.join(" | ")} |`, `| --- | ${cfgs.map(() => "---").join(" | ")} |`);
lines.push(`| Correct outcome (brief or reject) | ${cfgs.map((c) => `${r.summary[c].outcome_accuracy.correct}/${r.summary[c].outcome_accuracy.total}`).join(" | ")} |`);
lines.push(`| Every check passed | ${cfgs.map((c) => `${r.summary[c].deterministic.all_passed.briefs}/${r.summary[c].deterministic.all_passed.total}`).join(" | ")} |`);
lines.push(`| Briefs with numbers not in the post | ${cfgs.map((c) => r.summary[c].deterministic.briefs_with_unknown_numbers).join(" | ")} |`);
lines.push(`| Errors | ${cfgs.map((c) => r.summary[c].errors).join(" | ")} |`, "");
lines.push("## Rubric (mean, 1 to 5)", "", `| Dimension | ${cfgs.join(" | ")} |`, `| --- | ${cfgs.map(() => "---").join(" | ")} |`);
for (const d of DIMENSION_NAMES) lines.push(`| ${d} | ${cfgs.map((c) => r.summary[c].judge.mean_scores[d] ?? "n/a").join(" | ")} |`);
lines.push(`| overall: speedrun roles | ${cfgs.map((c) => r.summary[c].judge.overall_by_kind.speedrun ?? "n/a").join(" | ")} |`);
lines.push(`| overall: external roles | ${cfgs.map((c) => r.summary[c].judge.overall_by_kind.external ?? "n/a").join(" | ")} |`);
lines.push(`| Briefs with unsupported claims | ${cfgs.map((c) => `${r.summary[c].judge.briefs_with_unsupported_claims}/${r.summary[c].judge.judged}`).join(" | ")} |`, "");
lines.push("## Cost and latency", "", `| | ${cfgs.join(" | ")} |`, `| --- | ${cfgs.map(() => "---").join(" | ")} |`);
lines.push(`| Median / p95 latency | ${cfgs.map((c) => `${r.summary[c].latency_ms.median} / ${r.summary[c].latency_ms.p95} ms`).join(" | ")} |`);
lines.push(`| Generation tokens in / out | ${cfgs.map((c) => `${r.summary[c].tokens.input} / ${r.summary[c].tokens.output}`).join(" | ")} |`, "");
for (const c of cfgs) {
  const w = r.weaknesses[c];
  lines.push(`## Weakest areas: ${c}`, "");
  for (const d of w.dims) lines.push(`- ${d.dimension}: mean ${d.mean}`);
  lines.push("", "Lowest-scoring briefs:");
  for (const x of w.cases) lines.push(`- ${x.case} (overall ${x.overall}): ${x.weakness}`);
  lines.push("");
}
lines.push("Before changing the production prompt or model on the strength of this, read the flagged briefs yourself and rerun with --runs 3 to see the variance.");
console.log(lines.join("\n"));
