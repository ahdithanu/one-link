import { getRedis } from "./limit";
import { SERVER } from "./mcp";
import { dailyCap, talentBreaker } from "./network";

// What /api/health reports. It never includes secret values: only whether things are configured,
// reachable, and how they're behaving. "degraded" names anything weaker than intended.
export type Health = {
  ok: boolean;
  service: "one-link";
  version: string;
  checkedAt: string;
  limits: { scope: "global" | "per-instance"; redis: { configured: boolean; reachable: boolean | null; latencyMs: number | null } };
  dailyBudget: { cap: number; usedToday: number | null };
  model: { configured: boolean };
  talentApi: ReturnType<typeof talentBreaker.snapshot>;
  degraded: string[];
};

// Races a call against a deadline and always clears the timer, so nothing is left pending.
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export async function healthReport(extra: { degraded?: string[] } = {}): Promise<Health> {
  const redis = getRedis();
  let reachable: boolean | null = null;
  let latencyMs: number | null = null;
  let usedToday: number | null = null;
  if (redis) {
    const t0 = Date.now();
    try {
      await within(redis.ping(), 1500);
      reachable = true;
      latencyMs = Date.now() - t0;
      usedToday = Number(await within(redis.get(`one-link:spend:${new Date().toISOString().slice(0, 10)}`), 1500)) || 0;
    } catch {
      reachable = false;
    }
  }
  const global = Boolean(redis && reachable);
  const degraded = [...(extra.degraded ?? [])];
  if (!redis) degraded.push("No shared store configured: rate limits and the daily budget are per instance.");
  else if (!reachable) degraded.push("Shared store unreachable: rate limits have fallen back to per instance.");
  const model = Boolean(process.env.ANTHROPIC_API_KEY);
  if (!model) degraded.push("No model key: new briefs are switched off.");
  const talentApi = talentBreaker.snapshot();
  if (talentApi.state !== "closed") degraded.push(`Talent network API circuit is ${talentApi.state}: search serves cached results where it can.`);
  return {
    ok: true,
    service: "one-link",
    version: SERVER.version,
    checkedAt: new Date().toISOString(),
    limits: { scope: global ? "global" : "per-instance", redis: { configured: Boolean(redis), reachable, latencyMs } },
    dailyBudget: { cap: dailyCap(), usedToday },
    model: { configured: model },
    talentApi,
    degraded,
  };
}
