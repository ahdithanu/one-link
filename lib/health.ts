import { getRedis } from "./limit";
import { SERVER } from "./mcp";
import { dailyCap } from "./network";

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
  degraded: string[];
};

const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms).unref?.());

export async function healthReport(extra: { degraded?: string[] } = {}): Promise<Health> {
  const redis = getRedis();
  let reachable: boolean | null = null;
  let latencyMs: number | null = null;
  let usedToday: number | null = null;
  if (redis) {
    const t0 = Date.now();
    try {
      await Promise.race([redis.ping(), timeout(1500)]);
      reachable = true;
      latencyMs = Date.now() - t0;
      usedToday = Number(await Promise.race([redis.get(`one-link:spend:${new Date().toISOString().slice(0, 10)}`), timeout(1500)])) || 0;
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
  return {
    ok: true,
    service: "one-link",
    version: SERVER.version,
    checkedAt: new Date().toISOString(),
    limits: { scope: global ? "global" : "per-instance", redis: { configured: Boolean(redis), reachable, latencyMs } },
    dailyBudget: { cap: dailyCap(), usedToday },
    model: { configured: model },
    degraded,
  };
}
