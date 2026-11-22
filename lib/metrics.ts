// Turns One Link's structured log lines into operating metrics. Pure: feed it lines, get numbers.
// Lines can be raw JSON (from stdout) or wrapped by an export tool as {"message": "<json>"}.

type Line = Record<string, unknown>;

// claude-opus-5-5 list prices, USD per million tokens (input, output). Update if pricing changes.
export const PRICE_PER_MTOK = { input: 4, output: 20 };

export function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    const s = raw.trim();
    if (!s.startsWith("{")) continue;
    try {
      let j = JSON.parse(s) as Line;
      if (typeof j.message === "string" && j.message.trim().startsWith("{")) j = JSON.parse(j.message) as Line;
      if (typeof j.event === "string") out.push(j);
    } catch {
      // not one of ours
    }
  }
  return out;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

const GENERATING = new Set(["brief_for_job", "brief_from_job_post", "/api/brief", "/api/job-brief"]);

export function report(lines: Line[]) {
  const requests = lines.filter((l) => l.event === "mcp_request" || l.event === "web_request");
  const mcp = requests.filter((l) => l.event === "mcp_request");
  const byTool = new Map<string, Line[]>();
  for (const l of requests) {
    const key = (l.tool as string) ?? (l.event === "web_request" ? (l.method as string) : null);
    if (!key) continue;
    byTool.set(key, [...(byTool.get(key) ?? []), l]);
  }
  const tools = Object.fromEntries(
    [...byTool].map(([name, ls]) => {
      const ms = ls.map((l) => Number(l.duration_ms));
      return [name, { calls: ls.length, success_rate: rate(ls.filter((l) => l.ok).length, ls.length), p50_ms: pct(ms, 50), p95_ms: pct(ms, 95) }];
    }),
  );
  const count = (pred: (l: Line) => boolean) => requests.filter(pred).length;
  const cat = (c: string) => (l: Line) => l.error_category === c;
  const gen = requests.filter((l) => GENERATING.has((l.tool as string) ?? (l.method as string)));
  const genModelCalls = gen.filter((l) => l.usage);
  const tokens = requests.reduce<{ input: number; output: number }>(
    (t, l) => {
      const u = l.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return u ? { input: t.input + (u.input_tokens ?? 0), output: t.output + (u.output_tokens ?? 0) } : t;
    },
    { input: 0, output: 0 },
  );
  const talent = lines.filter((l) => l.event === "talent_api");
  const talentMs = talent.map((l) => Number(l.duration_ms));
  return {
    window: { lines: lines.length, requests: requests.length },
    mcp_availability: rate(mcp.filter((l) => Number(l.status) < 500).length, mcp.length),
    tools,
    brief_generation: {
      attempts: gen.length,
      success_rate: rate(gen.filter((l) => l.ok).length, gen.length),
      model_calls: genModelCalls.length,
    },
    model_failures: { model_error: count(cat("model_error")), model_rate_limited: count(cat("model_rate_limited")), model_unavailable: count(cat("model_unavailable")) },
    rate_limit_rejections: count(cat("rate_limited")),
    budget: { exhausted: count(cat("budget_exhausted")), unavailable: count(cat("budget_unavailable")) },
    talent_api: {
      calls: talent.length,
      failure_rate: rate(talent.filter((l) => !l.ok).length, talent.length),
      p50_ms: pct(talentMs, 50),
      p95_ms: pct(talentMs, 95),
      breaker_opens: lines.filter((l) => l.event === "talent_api_breaker" && l.to === "open").length,
    },
    redis_fallbacks: lines.filter((l) => l.event === "rate_limit_fallback" || l.event === "brief_lock_fallback").length,
    model_spend: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      usd: Math.round(((tokens.input * PRICE_PER_MTOK.input + tokens.output * PRICE_PER_MTOK.output) / 1e6) * 100) / 100,
    },
  };
}
