import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";
import { generateBrief } from "./brief";
import type { Board, Brief, Role } from "./data";
import type { ErrorCategory, Usage } from "./log";
import { BreakerOpenError, createBreaker } from "./breaker";
import { getRedis, reserveDaily } from "./limit";
import { acquireLock, lockHeld, releaseLock } from "./lock";
import { MIN_POST } from "./make-brief";
import { toRole, type Job } from "./refresh";

// Live search over the whole speedrun talent network (about 23k roles), plus briefs written the
// first time someone asks for one. The network API only pages through about 10k roles, so there
// is no local index: every search goes to the API, cached briefly per instance.

const API = "https://speedrun-talent-network.com/api/v1";
const SOURCE = "one-link";
const DAY = 24 * 60 * 60 * 1000;
export const PAGE_SIZE = 50;
export const MAX_PAGE = 200;

export type NetRole = Role & { tier: string | null };
// staleMinutes is set when the talent network is unavailable and this is the last good copy.
export type SearchResult = { total: number; page: number; hasMore: boolean; roles: NetRole[]; staleMinutes?: number };
export type SearchQuery = { q?: string; fn?: string; page?: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJobId = (id: string) => UUID.test(id) || /^[0-9a-f]{8}$/.test(id);

type ApiJob = Job & { tier?: string | null };

export function toNetRole(job: ApiJob, now = Date.now()): NetRole {
  const role = toRole(job);
  const ageDays = role.posted ? Math.max(0, Math.floor((now - Date.parse(role.posted)) / DAY)) : 0;
  const pay = role.pay.kind === "estimate" && job.tier !== "speedrun" ? { kind: "unposted" as const } : role.pay;
  return { ...role, ageDays, pay, tier: job.tier ?? null };
}

// A small bounded cache: identical requests within the TTL reuse one API call. The last good value
// for each key is also kept for up to STALE_MS, and served (marked stale) if a fresh load fails.
const STALE_MS = 60 * 60_000;
type Cached<T> = { value: T; staleMs?: number };
export function ttlCache<T>(ttlMs: number, max = 500) {
  const entries = new Map<string, { at: number; value: Promise<Cached<T>> }>();
  const good = new Map<string, { at: number; value: T }>();
  const bound = (m: Map<string, unknown>) => m.size >= max && m.delete(m.keys().next().value!);
  return (key: string, load: () => Promise<T>, now = Date.now()): Promise<Cached<T>> => {
    const hit = entries.get(key);
    if (hit && now - hit.at < ttlMs && now >= hit.at) return hit.value;
    bound(entries);
    const value = load().then(
      (v) => {
        bound(good);
        good.set(key, { at: Date.now(), value: v });
        return { value: v };
      },
      (err) => {
        entries.delete(key);
        const last = good.get(key);
        if (last && Date.now() - last.at < STALE_MS) return { value: last.value, staleMs: Date.now() - last.at };
        throw err;
      },
    );
    entries.set(key, { at: now, value });
    return value;
  };
}

export type NetworkDeps = {
  getJson: (url: string) => Promise<unknown>;
  hasKey: () => boolean;
  generate: (post: string, onUsage: (u: Usage) => void) => Promise<Brief | null>;
  loadSaved: (id: string) => Promise<SavedJobBrief | null>;
  save: (saved: SavedJobBrief) => Promise<void>;
  // Reserves one of today's new briefs before the model call. Returns a function that gives the
  // slot back, or null when the day's budget is used up.
  reserveBrief: () => Promise<(() => Promise<void>) | null>;
  // Cross-instance lock per job. Null when no shared store is configured (in-process joining only).
  lock?: JobLock | null;
  // How long a request waits for another instance's write before giving up (bounded by the 60 s limit).
  waitMs?: number;
  pollMs?: number;
};

export type JobLock = {
  acquire: (jobId: string) => Promise<string | null>;
  release: (jobId: string, token: string) => Promise<void>;
  held: (jobId: string) => Promise<boolean>;
};

// 90 s outlives one generation (45 s model timeout, 1 retry, save) but frees a crashed worker's lock.
export const LOCK_TTL_MS = 90_000;
const lockKey = (jobId: string) => `one-link:lock:brief:${jobId}`;

export function redisJobLock(): JobLock | null {
  const redis = getRedis();
  if (!redis) return null;
  return {
    acquire: (id) => acquireLock(redis, lockKey(id), LOCK_TTL_MS),
    release: async (id, token) => void (await releaseLock(redis, lockKey(id), token)),
    held: (id) => lockHeld(redis, lockKey(id)),
  };
}

export type SavedJobBrief = { role: NetRole; brief: Brief; at: string };

// The talent network API (https://speedrun-talent-network.com/developers): public, read-only, no
// auth. One breaker guards every call. Each call gets an 8 s timeout per attempt and at most one
// retry, only for network errors, timeouts and 5xx, never for 429, so we respect their rate limit.
// A 404 is an answer, not an outage, so it doesn't count against the breaker.
class UpstreamError extends Error {
  constructor(public status: number) {
    super(`${status} from the talent network`);
  }
}
const isOutage = (err: unknown) => !(err instanceof UpstreamError) || err.status >= 500 || err.status === 429;
const retryable = (err: unknown) => !(err instanceof UpstreamError) || err.status >= 500;

export const talentBreaker = createBreaker({
  onTransition: (from, to) => console.warn(JSON.stringify({ event: "talent_api_breaker", from, to })),
});

async function attempt(url: string) {
  const res = await fetch(url, { headers: { "user-agent": SOURCE }, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new UpstreamError(res.status);
  return res.json();
}

export async function getJson(url: string) {
  const op = new URL(url).pathname.endsWith("/jobs") ? "search" : "job";
  const started = Date.now();
  let attempts = 0;
  let status: number | null = null;
  try {
    // Answers that aren't outages (a 404, say) are carried out of the breaker so they don't count.
    const out = await talentBreaker.run(async () => {
      const once = async () => {
        attempts++;
        return await attempt(url);
      };
      try {
        try {
          return { data: await once() };
        } catch (err) {
          if (!retryable(err)) throw err;
          await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
          return { data: await once() };
        }
      } catch (err) {
        if (!isOutage(err)) return { answer: err };
        throw err;
      }
    });
    if ("answer" in out) throw out.answer;
    status = 200;
    return out.data;
  } catch (err) {
    status = err instanceof UpstreamError ? err.status : err instanceof BreakerOpenError ? 0 : -1;
    throw err;
  } finally {
    // No query text or job ids: only what's needed to see the dependency's health.
    console.log(JSON.stringify({ event: "talent_api", op, ok: status === 200, status, attempts, duration_ms: Date.now() - started, breaker: talentBreaker.snapshot().state }));
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const write = { access: "private", addRandomSuffix: false } as const;

export const defaultNetworkDeps: NetworkDeps = {
  get lock() {
    return redisJobLock();
  },
  getJson,
  hasKey: () => Boolean(process.env.ANTHROPIC_API_KEY),
  generate: async (post, onUsage) => {
    const g = await generateBrief(post, onUsage);
    if (!g) return null;
    const { company: _c, title: _t, ...brief } = g;
    return brief;
  },
  loadSaved: async (id) => {
    const blob = await get(`jobbriefs/${id}.json`, { access: "private" }).catch(() => null);
    if (!blob || blob.statusCode !== 200) return null;
    return new Response(blob.stream).json();
  },
  save: async (saved) => {
    await put(`jobbriefs/${saved.role.id}.json`, JSON.stringify(saved), { ...write, contentType: "application/json", allowOverwrite: true });
  },
  reserveBrief: async () => {
    const cap = dailyCap();
    const redis = getRedis();
    if (redis) {
      // Atomic across instances. If Redis fails, fall back to the blob count below.
      try {
        return await reserveDaily(redis, cap);
      } catch {}
    }
    return reserveWithBlobs(cap);
  },
};

export function dailyCap() {
  const n = Number(process.env.DAILY_BRIEF_CAP);
  return Number.isInteger(n) && n >= 0 ? n : 100;
}

// Without Redis: one marker blob per brief. Counting then writing isn't atomic, so two instances
// racing at the limit can go a little over. Redis removes that race.
async function reserveWithBlobs(cap: number) {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `spend/${today()}/`, limit: 1000, cursor });
    count += page.blobs.length;
    cursor = page.cursor;
  } while (cursor);
  if (count >= cap) return null;
  const marker = await put(`spend/${today()}/${randomUUID()}`, "1", { ...write, contentType: "text/plain" });
  return async () => {
    await del(marker.url);
  };
}

const searchCache = ttlCache<SearchResult>(5 * 60_000);
const jobCache = ttlCache<ApiJob>(10 * 60_000);

export function searchNetwork(query: SearchQuery, deps: Pick<NetworkDeps, "getJson"> = defaultNetworkDeps): Promise<SearchResult> {
  const q = (query.q ?? "").trim().slice(0, 120);
  const fn = (query.fn ?? "").trim();
  const page = Math.min(Math.max(0, Math.floor(query.page ?? 0)), MAX_PAGE);
  const params = new URLSearchParams({ scope: "all", page: String(page), source: SOURCE });
  if (q) params.set("q", q);
  if (/^[a-z_]{2,40}$/.test(fn)) params.set("fn", fn);
  const url = `${API}/jobs?${params}`;
  return searchCache(url, async () => {
    const data = (await deps.getJson(url)) as { jobs?: ApiJob[]; total?: number; has_more?: boolean };
    const roles = (data.jobs ?? []).filter((j) => !j.stealth).map((j) => toNetRole(j));
    return { total: data.total ?? roles.length, page, hasMore: Boolean(data.has_more) && page < MAX_PAGE, roles };
  }).then((c) => (c.staleMs === undefined ? c.value : { ...c.value, staleMinutes: Math.max(1, Math.round(c.staleMs / 60_000)) }));
}

export function getNetworkJob(id: string, deps: Pick<NetworkDeps, "getJson"> = defaultNetworkDeps): Promise<ApiJob | null> {
  if (!isJobId(id)) return Promise.resolve(null);
  return jobCache(id, async () => {
    const data = (await deps.getJson(`${API}/jobs/${id}?source=${SOURCE}`)) as { job?: ApiJob };
    if (!data.job?.id) throw new Error("No job in the response");
    return data.job;
  })
    .then((c) => c.value)
    .catch(() => null);
}

export type JobBriefResult =
  | { role: NetRole; brief: Brief; cached: boolean; usage?: Usage }
  | { error: string; status: number; category: ErrorCategory; role?: NetRole; usage?: Usage };

const fail = (error: string, status: number, category: ErrorCategory, extra: { role?: NetRole; usage?: Usage } = {}) => ({ error, status, category, ...extra });

// One generation per job at a time, per instance. A second request for the same job while the
// first is being written joins it instead of paying for another model call. A finished brief stays
// here for a minute, which also covers the moment before the saved copy is readable from Blob.
// Across instances this is not a lock: two instances can still both write (see the README).
const inflight = new Map<string, Promise<JobBriefResult>>();
const RECENT_MS = 60_000;

// Free paths first: the speedrun board, a brief being written right now, a saved brief. Only "new"
// costs a model call, so callers apply the per-caller rate limit only to that.
export async function lookupJobBrief(id: string, board: Board, deps: NetworkDeps = defaultNetworkDeps) {
  if (!isJobId(id)) return { kind: "invalid" as const };
  const fromBoard = board.roles.find((r) => (id.length === 8 ? r.short === id : r.id === id));
  if (fromBoard && board.briefs[fromBoard.id]) return { kind: "board" as const, role: fromBoard, brief: board.briefs[fromBoard.id] };
  const job = await getNetworkJob(id, deps);
  if (!job) return { kind: "missing" as const };
  if (inflight.has(job.id)) return { kind: "pending" as const, job };
  const saved = await deps.loadSaved(job.id).catch(() => null);
  if (saved) return { kind: "saved" as const, role: toNetRole(job), brief: saved.brief };
  return { kind: "new" as const, job };
}

export function writeJobBrief(job: ApiJob, deps: NetworkDeps = defaultNetworkDeps): Promise<JobBriefResult> {
  const running = inflight.get(job.id);
  // Joiners get the same brief, marked cached and without usage, so tokens are logged once.
  if (running) return running.then((r) => ("error" in r ? r : { role: r.role, brief: r.brief, cached: true }));
  const p = coordinatedWrite(job, deps);
  inflight.set(job.id, p);
  p.then(
    (r) => {
      if ("error" in r) inflight.delete(job.id);
      else setTimeout(() => inflight.delete(job.id), RECENT_MS).unref?.();
    },
    () => inflight.delete(job.id),
  );
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Across instances: take the job's lock, then check for a saved brief before paying for one. If
// another instance holds the lock, wait (bounded) for its brief to appear instead of writing a
// second one. If the lock disappears without a brief (that write failed), try to take it.
export async function coordinatedWrite(job: ApiJob, deps: NetworkDeps): Promise<JobBriefResult> {
  const lock = deps.lock;
  if (!lock) return generateJobBrief(job, deps);
  const deadline = Date.now() + (deps.waitMs ?? 40_000);
  for (;;) {
    let token: string | null;
    try {
      token = await lock.acquire(job.id);
    } catch {
      // Redis unreachable: write without the cross-instance lock (in-process joining still applies).
      console.warn(JSON.stringify({ event: "brief_lock_fallback", detail: "shared store unavailable, writing without a cross-instance lock" }));
      return generateJobBrief(job, deps);
    }
    if (token) {
      try {
        const saved = await deps.loadSaved(job.id).catch(() => null);
        if (saved) return { role: toNetRole(job), brief: saved.brief, cached: true };
        return await generateJobBrief(job, deps);
      } finally {
        await lock.release(job.id, token).catch(() => {});
      }
    }
    // Another instance is writing this brief.
    while (Date.now() < deadline) {
      await sleep(deps.pollMs ?? 1500);
      const saved = await deps.loadSaved(job.id).catch(() => null);
      if (saved) return { role: toNetRole(job), brief: saved.brief, cached: true };
      if (!(await lock.held(job.id).catch(() => true))) break;
    }
    if (Date.now() >= deadline)
      return fail("Another request is writing this brief right now. Try again in a few seconds.", 409, "brief_in_progress", { role: toNetRole(job) });
  }
}

async function generateJobBrief(job: ApiJob, deps: NetworkDeps): Promise<JobBriefResult> {
  const role = toNetRole(job);
  if (!deps.hasKey()) return fail("Live briefs are switched off right now.", 503, "model_unavailable", { role });
  if (job.status && job.status !== "open") return fail("This role is no longer open, so there's no brief to write.", 410, "not_found", { role });
  const desc = job.description_text ?? "";
  if (desc.length < MIN_POST) return fail("This listing has too little description to brief from.", 422, "not_a_job_post", { role });
  // If the budget can't be checked, refuse: this path spends money.
  const release = await deps.reserveBrief().catch(() => null);
  if (!release) return fail("Today's budget for new briefs is used up. Try again tomorrow.", 503, "budget_exhausted", { role });

  let usage: Usage | undefined;
  try {
    const brief = await deps.generate(desc, (u) => (usage = u));
    // A rejected post still cost a model call, so it keeps its slot in the budget.
    if (!brief) return fail("This listing doesn't read like a job post, so there's no brief.", 422, "not_a_job_post", { role, usage });
    await deps.save({ role, brief, at: new Date().toISOString() }).catch(() => {});
    return { role, brief, cached: false, ...(usage && { usage }) };
  } catch (err) {
    // The model call failed, so give the slot back.
    await release().catch(() => {});
    // Checked by status: errors from the SDK's other build fail instanceof.
    const status = (err as { status?: unknown }).status;
    if (err instanceof Anthropic.RateLimitError || status === 429) return fail("It's busy right now. Try again in a minute.", 503, "model_rate_limited", { role, usage });
    if (err instanceof Anthropic.APIError || typeof status === "number") return fail("Brief generation failed. Try again in a minute.", 502, "model_error", { role, usage });
    throw err;
  }
}
