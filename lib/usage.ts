// MCP usage counts: calls per tool, clients, and unique callers per day and all time.
//
// Unique callers are counted with Redis HyperLogLog over the same HMAC'd caller key the rate
// limits use, so no IP address is stored, and the count is an estimate (standard error about
// 0.8%). One caller is one network address: people behind the same office NAT count once, and
// someone switching networks counts twice. Nothing about arguments or job text is recorded.
//
// Needs Redis (Upstash). Without it nothing is recorded; /stats says so.
import type { Redis } from "@upstash/redis";
import { TOOLS } from "./mcp";

export type McpUsage = { method: string; tool?: string; ok: boolean; client?: string };
export type UsageStore = Pick<Redis, "eval" | "hgetall" | "pfcount">;

const TOOL_NAMES = new Set<string>(TOOLS.map((t) => t.name));
const KEEP_SECONDS = 400 * 24 * 3600;
// Client names come from the caller, so cap how many distinct ones a day can hold.
const MAX_FIELDS = 300;

export const day = (d = new Date()) => d.toISOString().slice(0, 10);

// clientInfo.name is free text from the caller: keep a short, plain version.
export function cleanClient(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const s = name.toLowerCase().replace(/[^a-z0-9 ._-]/g, "").trim().slice(0, 40);
  return s || undefined;
}

// Which hash fields to bump for one request. Pure, so it's unit tested.
export function fields(u: McpUsage): string[] {
  const out = [`method:${u.method.length <= 40 ? u.method : "other"}`];
  if (u.method === "tools/call") {
    const tool = u.tool && TOOL_NAMES.has(u.tool) ? u.tool : "other";
    out.push("calls", `tool:${tool}`);
    if (!u.ok) out.push("errors", `tool:${tool}:err`);
  }
  if (u.method === "initialize") out.push("connects", `client:${cleanClient(u.client) ?? "unknown"}`);
  return out;
}

// One atomic script: bump the day's counters (new fields only while under the cap), add the caller
// to today's and the all-time unique sets, and keep the day's keys for KEEP_SECONDS.
// KEYS: day hash, day callers, all callers, day tool callers. ARGV: keep, max fields, caller, counts tool call (0/1), fields...
const RECORD = `
for i = 5, #ARGV do
  if redis.call("HEXISTS", KEYS[1], ARGV[i]) == 1 or redis.call("HLEN", KEYS[1]) < tonumber(ARGV[2]) then
    redis.call("HINCRBY", KEYS[1], ARGV[i], 1)
  end
end
redis.call("PFADD", KEYS[2], ARGV[3])
redis.call("PFADD", KEYS[3], ARGV[3])
if ARGV[4] == "1" then redis.call("PFADD", KEYS[4], ARGV[3]) end
redis.call("EXPIRE", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[2], ARGV[1])
redis.call("EXPIRE", KEYS[4], ARGV[1])
return 1`;

export async function recordUsage(store: Pick<Redis, "eval">, caller: string, u: McpUsage, d = day()) {
  const toolCall = u.method === "tools/call" ? "1" : "0";
  await store.eval(
    RECORD,
    [`usage:d:${d}`, `usage:u:${d}`, "usage:u:all", `usage:t:${d}`],
    [String(KEEP_SECONDS), String(MAX_FIELDS), caller, toolCall, ...fields(u)],
  );
}

export type DayUsage = {
  day: string;
  callers: number;
  toolCallers: number;
  calls: number;
  errors: number;
  connects: number;
  tools: Record<string, number>;
  clients: Record<string, number>;
};

export function toDay(d: string, h: Record<string, unknown> | null, callers: number, toolCallers: number): DayUsage {
  const n = (k: string) => Number(h?.[k] ?? 0);
  const pick = (prefix: string) =>
    Object.fromEntries(
      Object.entries(h ?? {})
        .filter(([k]) => k.startsWith(prefix) && !k.endsWith(":err"))
        .map(([k, v]) => [k.slice(prefix.length), Number(v)]),
    );
  return { day: d, callers, toolCallers, calls: n("calls"), errors: n("errors"), connects: n("connects"), tools: pick("tool:"), clients: pick("client:") };
}

export async function readUsage(store: UsageStore, days = 30, now = new Date()) {
  const list = Array.from({ length: days }, (_, i) => day(new Date(now.getTime() - i * 86_400_000)));
  const rows = await Promise.all(
    list.map(async (d) => {
      const [h, callers, toolCallers] = await Promise.all([
        store.hgetall<Record<string, unknown>>(`usage:d:${d}`),
        store.pfcount(`usage:u:${d}`),
        store.pfcount(`usage:t:${d}`),
      ]);
      return toDay(d, h, callers, toolCallers);
    }),
  );
  const keys = (prefix: string, n: number) => list.slice(0, n).map((d) => `${prefix}${d}`) as [string, ...string[]];
  const [allTime, week, period, periodTools] = await Promise.all([
    store.pfcount("usage:u:all"),
    store.pfcount(...keys("usage:u:", Math.min(7, days))),
    store.pfcount(...keys("usage:u:", days)),
    store.pfcount(...keys("usage:t:", days)),
  ]);
  return { days: rows, uniqueCallers: { allTime, week, period, periodToolCallers: periodTools } };
}
