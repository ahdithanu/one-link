// Brief-quality evaluation. Calls real models, so it costs money and isn't part of CI.
//
//   ANTHROPIC_API_KEY=... npx tsx eval/model.mts                    # prints the cost estimate only
//   ANTHROPIC_API_KEY=... npx tsx eval/model.mts --confirm          # runs the production config
//   ANTHROPIC_API_KEY=... npx tsx eval/model.mts --config prod,opus-medium,sonnet-low --confirm
//   npx tsx eval/model.mts --dry-run                                # whole pipeline with stub models, no key, no cost
//
// Options: --config <names>  --runs <n>  --limit <n cases>  --judge-model <id>  --out <file>
//
// Two layers, reported separately:
// 1. Deterministic checks on every output (format rules, verbatim evidence, injection, invented numbers).
// 2. A model judge scores ten rubric dimensions (eval/quality.ts) and lists unsupported claims. The
//    judge is itself a model: treat its scores as an estimate, and don't change the production
//    prompt on its say-so alone. Read the briefs it flags.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateBrief, MODEL, type GeneratedBrief, type GenerateOptions } from "../lib/brief";
import { deterministic, Judgement, JUDGE_PROMPT, RUBRIC_VERSION, summarize, weaknesses, type Case, type JudgementT, type Row } from "./quality";

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const DRY = process.argv.includes("--dry-run");
const RUNS = Number(arg("--runs") ?? 1);
const LIMIT = arg("--limit") ? Number(arg("--limit")) : Infinity;
const JUDGE_MODEL = arg("--judge-model") ?? MODEL;

// Production is "prod". The others are what's worth comparing it against.
const CONFIGS: Record<string, GenerateOptions & { price: [number, number] }> = {
  prod: { model: MODEL, effort: "low", price: [4, 20] },
  "opus-medium": { model: MODEL, effort: "medium", price: [4, 20] },
  "sonnet-low": { model: "claude-sonnet-5-5", effort: "low", price: [2, 10] },
};
const configNames = (arg("--config") ?? "prod").split(",");
for (const c of configNames) if (!CONFIGS[c]) throw new Error(`Unknown config ${c}. Options: ${Object.keys(CONFIGS).join(", ")}`);

// Dataset: speedrun posts, non-speedrun posts across functions, and adversarial cases.
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const speedrun = read("eval/dataset/posts.json").posts.map((p: Case) => ({ ...p, kind: "speedrun", expect: "brief" }));
const external = read("eval/dataset/external.json").posts.map((p: Case) => ({ ...p, kind: "external", expect: "brief" }));
const adversarial = read("eval/dataset/adversarial.json").posts.map((p: Case) => ({ ...p, kind: "adversarial" }));
const cases: Case[] = [...speedrun, ...external, ...adversarial].slice(0, LIMIT);
const datasetHash = createHash("sha256").update(JSON.stringify(cases)).digest("hex").slice(0, 12);

// Rough per-call token sizes from production logs of this prompt: generation ~2k in / 1.5k out,
// judge ~3.5k in / 1.2k out. Used only for the estimate.
const judgePrice = JUDGE_MODEL.includes("sonnet") ? [2, 10] : [4, 20];
const estimate = configNames.reduce((usd, c) => {
  const [pi, po] = CONFIGS[c].price;
  const perCase = (2000 * pi + 1500 * po + 3500 * judgePrice[0] + 1200 * judgePrice[1]) / 1e6;
  return usd + perCase * cases.length * RUNS;
}, 0);
console.log(`${cases.length} cases × ${configNames.length} config(s) × ${RUNS} run(s), judge ${JUDGE_MODEL}. Estimated cost: about $${estimate.toFixed(2)}.`);

if (!DRY) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes("...")) {
    console.error(key ? "ANTHROPIC_API_KEY is still the placeholder. Paste a real key from console.anthropic.com." : "Set ANTHROPIC_API_KEY to run the model eval (or use --dry-run).");
    process.exit(2);
  }
  if (!process.argv.includes("--confirm")) {
    console.log("Nothing was run. Add --confirm to run it and spend that.");
    process.exit(0);
  }
}

// Stubs for --dry-run: deterministic and free, so the pipeline and report can be checked without a key.
const stubBrief = (c: Case): GeneratedBrief | null =>
  c.expect === "reject"
    ? null
    : {
        company: c.company ?? "Acme",
        title: c.title ?? "Engineer",
        need: "A stub need.",
        evidence: c.post.split(/\s+/).slice(0, 6).join(" "),
        build: { title: "Stub build", pitch: "A stub pitch." },
        plan: [
          { when: "Saturday morning", do: "a" },
          { when: "Saturday afternoon", do: "b" },
          { when: "Sunday", do: "c" },
        ],
        good: ["x", "y", "z"],
        avoid: "a",
        opener: "I built a stub. [your link]",
      };
const stubJudge = (): JudgementT => ({
  scores: Object.fromEntries(Object.keys(Judgement.shape.scores.shape).map((d) => [d, { score: 3, reason: "stub" }])) as JudgementT["scores"],
  unsupported_claims: [],
  biggest_weakness: "stub",
});

const judgeClient = DRY ? null : new Anthropic({ timeout: 90_000, maxRetries: 2 });
async function judge(post: string, brief: GeneratedBrief) {
  if (!judgeClient) return { judgement: stubJudge(), usage: { input_tokens: 0, output_tokens: 0 } };
  const res = await judgeClient.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 4000,
    system: JUDGE_PROMPT,
    output_config: { effort: "medium", format: zodOutputFormat(Judgement) },
    messages: [{ role: "user", content: `<job_post>\n${post}\n</job_post>\n<brief>\n${JSON.stringify(brief, null, 2)}\n</brief>` }],
  });
  return { judgement: res.parsed_output, usage: res.usage };
}

const rows: Row[] = [];
const judgeTokens = { input: 0, output: 0 };
for (const cfg of configNames) {
  for (let run = 1; run <= RUNS; run++) {
    for (const c of cases) {
      const t0 = performance.now();
      let usage: Row["usage"];
      let brief: GeneratedBrief | null = null;
      let error: string | undefined;
      try {
        brief = DRY ? stubBrief(c) : await generateBrief(c.post, (u) => (usage = u), CONFIGS[cfg]);
      } catch (err) {
        // A bad key is a setup problem, not a result: stop before writing anything.
        const status = (err as { status?: unknown }).status;
        if (status === 401 || status === 403) {
          console.error(`Stopped: the API rejected the key (${status}). No results were written.`);
          process.exit(2);
        }
        error = err instanceof Error ? `${err.constructor.name}: ${err.message.slice(0, 200)}` : String(err);
      }
      const outcome = error ? "error" : brief ? "brief" : "rejected";
      const expected = c.expect === "reject" ? "rejected" : "brief";
      const row: Row = { config: cfg, case: c.id, kind: c.kind, ...(c.function && { function: c.function }), run, outcome, expected, correct_outcome: outcome === expected, latency_ms: Math.round(performance.now() - t0), ...(usage && { usage }), ...(error && { error }) };
      if (brief) {
        Object.assign(row, deterministic(c, brief), { build_title: brief.build.title });
        try {
          const j = await judge(c.post, brief);
          row.judge = j.judgement;
          judgeTokens.input += j.usage.input_tokens;
          judgeTokens.output += j.usage.output_tokens;
        } catch {
          row.judge = null;
        }
      }
      rows.push(row);
      const failed = Object.entries(row.checks ?? {}).filter(([, v]) => !v).map(([k]) => k);
      console.log(
        `${cfg.padEnd(12)} ${c.id.padEnd(22)} ${outcome.padEnd(8)} ${row.correct_outcome ? "ok " : "BAD"} ${String(row.latency_ms).padStart(6)}ms` +
          (failed.length ? ` checks failed: ${failed.join(",")}` : "") +
          (row.judge ? ` overall=${row.judge.scores.overall_usefulness.score} unsupported=${row.judge.unsupported_claims.length}` : ""),
      );
    }
  }
}

const summary = summarize(rows);
const report = {
  dry_run: DRY,
  ran_at: new Date().toISOString(),
  rubric_version: RUBRIC_VERSION,
  dataset: { hash: datasetHash, cases: cases.length, speedrun: speedrun.length, external: external.length, adversarial: adversarial.length },
  configs: Object.fromEntries(configNames.map((c) => [c, { model: CONFIGS[c].model, effort: CONFIGS[c].effort }])),
  judge_model: JUDGE_MODEL,
  runs_per_case: RUNS,
  summary,
  weaknesses: Object.fromEntries(configNames.map((c) => [c, weaknesses(rows, c)])),
  judge_tokens: judgeTokens,
  rows,
};
const out = arg("--out") ?? (DRY ? "/tmp/one-link-model-eval-dryrun.json" : `eval/results/model-${report.ran_at.slice(0, 10)}.json`);
if (!DRY) mkdirSync("eval/results", { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`\nwrote ${out}${DRY ? " (dry run: stub models, not real results)" : ""}`);
for (const [cfg, s] of Object.entries(summary)) {
  console.log(`${cfg}: outcomes ${s.outcome_accuracy.correct}/${s.outcome_accuracy.total}, all checks passed ${s.deterministic.all_passed.briefs}/${s.deterministic.all_passed.total}, overall usefulness ${s.judge.mean_scores.overall_usefulness}`);
}
console.log("Summarize with: npx tsx eval/quality-report.mts " + out);
