// One "app instance" for the distributed tests: a separate process that shares only Redis with the
// others. Usage: tsx worker.mts <mode> <startAtMs> <arg>
import { getRedis, limited, reserveDaily } from "../lib/limit";
import { coordinatedWrite, redisJobLock, type SavedJobBrief } from "../lib/network";
import type { Brief } from "../lib/data";

const [mode, startAt, arg] = process.argv.slice(2);
const redis = getRedis()!;
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));

if (mode === "limit") {
  console.log(JSON.stringify({ limited: await limited(arg) }));
} else if (mode === "limit-many") {
  // Many different callers from this instance, so only the global limit can stop them.
  const [tag, n] = arg.split(":");
  const res = await Promise.all(Array.from({ length: Number(n) }, (_, i) => limited(`${tag}-${i}`)));
  console.log(JSON.stringify({ allowed: res.filter((x) => !x).length }));
} else if (mode === "reserve") {
  const [day, cap] = arg.split(":");
  console.log(JSON.stringify({ reserved: Boolean(await reserveDaily(redis, Number(cap), day)) }));
} else if (mode === "write") {
  const brief: Brief = {
    need: "n", evidence: "", build: { title: "t", pitch: "p" },
    plan: [{ when: "Saturday morning", do: "a" }, { when: "Saturday afternoon", do: "b" }, { when: "Sunday", do: "c" }],
    good: ["x", "y", "z"], avoid: "a", opener: "o",
  };
  const job = {
    id: arg, title: "Engineer", company: "Acme", url: "https://example.test", location: null, workplace_type: null, function: "engineering",
    comp_min: null, comp_max: null, published_at: "2026-11-01T00:00:00Z", stealth: false, status: "open", tier: "a16z",
    description_text: "We need someone to build reliable data pipelines for logistics customers. ".repeat(6),
  };
  const savedKey = `test:saved:${arg}`;
  const result = await coordinatedWrite(job, {
    getJson: async () => ({}),
    hasKey: () => true,
    // Counts model calls across every process, then takes long enough for the others to collide.
    generate: async () => {
      await redis.incr(`test:generations:${arg}`);
      await new Promise((r) => setTimeout(r, 800));
      return brief;
    },
    loadSaved: async () => ((await redis.get<SavedJobBrief>(savedKey)) ?? null),
    save: async (s) => void (await redis.set(savedKey, s, { ex: 600 })),
    reserveBrief: async () => async () => {},
    lock: redisJobLock(),
    pollMs: 200,
    waitMs: 15_000,
  });
  console.log(JSON.stringify("error" in result ? { error: result.category } : { cached: result.cached }));
}
