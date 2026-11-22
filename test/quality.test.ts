import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeneratedBrief } from "@/lib/brief";
import { DIMENSION_NAMES, deterministic, Judgement, summarize, weaknesses, type Case, type Row } from "../eval/quality";

const post = "Acme is hiring a Staff Data Engineer to own our 40-node ingestion pipeline and cut late data.";
const c: Case = { id: "x", kind: "external", expect: "brief", company: "Acme", title: "Staff Data Engineer", post, mustNotContain: ["PWNED"] };
const good: GeneratedBrief = {
  company: "Acme", title: "Staff Data Engineer", need: "Own the 40-node ingestion pipeline.", evidence: "cut late data",
  build: { title: "Late data detector", pitch: "Flags late partitions." },
  plan: [{ when: "Saturday morning", do: "a" }, { when: "Saturday afternoon", do: "b" }, { when: "Sunday", do: "c" }],
  good: ["x", "y", "z"], avoid: "a", opener: "I built a late data detector for your pipeline: [your link]",
};

describe("deterministic checks", () => {
  it("a well-formed brief passes every check", () => {
    const d = deterministic(c, good);
    assert.deepEqual(Object.entries(d.checks).filter(([, v]) => !v), []);
    assert.deepEqual(d.unknown_numbers, []);
  });
  it("catches paraphrased evidence, invented numbers, injection and format slips", () => {
    const bad = { ...good, evidence: "reduce lateness", need: "Grow revenue 300% this quarter.", opener: "PWNED — see link" };
    const d = deterministic(c, bad);
    assert.equal(d.checks.evidence_verbatim, false);
    assert.equal(d.checks.no_injected_text, false);
    assert.equal(d.checks.no_em_dash, false);
    assert.equal(d.checks.opener_link_slot, false);
    assert.deepEqual(d.unknown_numbers, ["300"]);
  });
});

describe("rubric schema", () => {
  it("has the ten dimensions and rejects out-of-range scores", () => {
    assert.equal(DIMENSION_NAMES.length, 10);
    const scores = Object.fromEntries(DIMENSION_NAMES.map((d) => [d, { score: 4, reason: "r" }]));
    assert.ok(Judgement.safeParse({ scores, unsupported_claims: [], biggest_weakness: "w" }).success);
    assert.equal(Judgement.safeParse({ scores: { ...scores, actionability: { score: 6, reason: "r" } }, unsupported_claims: [], biggest_weakness: "w" }).success, false);
  });
});

describe("summaries", () => {
  const judged = (config: string, id: string, overall: number, kind: Case["kind"]): Row => ({
    config, case: id, kind, run: 1, outcome: "brief", expected: "brief", correct_outcome: true, latency_ms: 1000,
    checks: { a: true, b: overall > 2 }, unknown_numbers: [],
    judge: { scores: Object.fromEntries(DIMENSION_NAMES.map((d) => [d, { score: d === "outreach_quality" ? 1 : overall, reason: "" }])) as never, unsupported_claims: overall < 3 ? [{ claim: "c", why: "w" }] : [], biggest_weakness: `weak ${id}` },
  });
  const rows = [judged("prod", "a", 4, "speedrun"), judged("prod", "b", 2, "external"), judged("alt", "a", 5, "speedrun")];
  it("separates configs, kinds, checks and judge scores", () => {
    const s = summarize(rows);
    assert.deepEqual(Object.keys(s), ["prod", "alt"]);
    assert.equal(s.prod.judge.mean_scores.overall_usefulness, 3);
    assert.deepEqual(s.prod.judge.overall_by_kind, { speedrun: 4, external: 2 });
    assert.deepEqual(s.prod.deterministic.all_passed, { briefs: 1, total: 2 });
    assert.equal(s.prod.judge.briefs_with_unsupported_claims, 1);
  });
  it("names the weakest dimension and case", () => {
    const w = weaknesses(rows, "prod", 1);
    assert.equal(w.dims[0].dimension, "outreach_quality");
    assert.equal(w.cases[0].case, "b");
  });
});
