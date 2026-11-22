// Operating metrics from exported logs. Usage:
//   npx tsx eval/log-report.mts logs.jsonl          (or pipe lines on stdin)
// Get lines with `vercel logs <deployment-url> --json > logs.jsonl` (recent runtime logs), or from a
// log drain. See docs/runbook.md.
import { readFileSync } from "node:fs";
import { parseLines, report } from "../lib/metrics";

const file = process.argv[2];
const text = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
console.log(JSON.stringify(report(parseLines(text)), null, 2));
