import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { get, list, put } from "@vercel/blob";
import { generateBrief } from "./brief";
import type { Board, Brief, Role } from "./data";
import type { ErrorCategory, Usage } from "./log";
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
export type SearchResult = { total: number; page: number; hasMore: boolean; roles: NetRole[] };
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

// A small bounded cache: identical searches within a few minutes reuse one API call.
function ttlCache<T>(ttlMs: number, max = 500) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>, now = Date.now()): Promise<T> => {
    const hit = entries.get(key);
    if (hit && now - hit.at < ttlMs && now >= hit.at) return hit.value;
    if (entries.size >= max) entries.delete(entries.keys().next().value!);
    const value = load();
    entries.set(key, { at: now, value });
    value.catch(() => entries.delete(key));
    return value;
  };
}

export type NetworkDeps = {
  getJson: (url: string) => Promise<unknown>;
  hasKey: () => boolean;
  generate: (post: string, onUsage: (u: Usage) => void) => Promise<Brief | null>;
  loadSaved: (id: string) => Promise<SavedJobBrief | null>;
  save: (saved: SavedJobBrief) => Promise<void>;
  briefsToday: () => Promise<number>;
  countBrief: () => Promise<void>;
  dailyCap: () => number;
};

export type SavedJobBrief = { role: NetRole; brief: Brief; at: string };

async function getJson(url: string) {
  const res = await fetch(url, { headers: { "user-agent": SOURCE }, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} from the talent network`);
  return res.json();
}

const today = () => new Date().toISOString().slice(0, 10);
const write = { access: "private", addRandomSuffix: false } as const;

export const defaultNetworkDeps: NetworkDeps = {
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
  // One empty marker per generated brief, counted across every instance.
  briefsToday: async () => {
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: `spend/${today()}/`, limit: 1000, cursor });
      count += page.blobs.length;
      cursor = page.cursor;
    } while (cursor);
    return count;
  },
  countBrief: async () => {
    await put(`spend/${today()}/${randomUUID()}`, "1", { ...write, contentType: "text/plain" });
  },
  dailyCap: () => {
    const n = Number(process.env.DAILY_BRIEF_CAP);
    return Number.isInteger(n) && n >= 0 ? n : 100;
  },
};

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
  });
}

export function getNetworkJob(id: string, deps: Pick<NetworkDeps, "getJson"> = defaultNetworkDeps): Promise<ApiJob | null> {
  if (!isJobId(id)) return Promise.resolve(null);
  return jobCache(id, async () => {
    const data = (await deps.getJson(`${API}/jobs/${id}?source=${SOURCE}`)) as { job?: ApiJob };
    if (!data.job?.id) throw new Error("No job in the response");
    return data.job;
  }).catch(() => null);
}

export type JobBriefResult =
  | { role: NetRole; brief: Brief; cached: boolean; usage?: Usage }
  | { error: string; status: number; category: ErrorCategory; role?: NetRole; usage?: Usage };

const fail = (error: string, status: number, category: ErrorCategory, extra: { role?: NetRole; usage?: Usage } = {}) => ({ error, status, category, ...extra });

// Returns a saved brief for free. Otherwise checks the daily cap and writes one. The caller applies
// the per-caller rate limit, and only needs to when `needsModel` says a model call will happen.
export async function lookupJobBrief(id: string, board: Board, deps: NetworkDeps = defaultNetworkDeps) {
  if (!isJobId(id)) return { kind: "invalid" as const };
  const fromBoard = board.roles.find((r) => (id.length === 8 ? r.short === id : r.id === id));
  if (fromBoard && board.briefs[fromBoard.id]) return { kind: "board" as const, role: fromBoard, brief: board.briefs[fromBoard.id] };
  const job = await getNetworkJob(id, deps);
  if (!job) return { kind: "missing" as const };
  const saved = await deps.loadSaved(job.id).catch(() => null);
  if (saved) return { kind: "saved" as const, role: toNetRole(job), brief: saved.brief };
  return { kind: "new" as const, job };
}

export async function writeJobBrief(job: ApiJob, deps: NetworkDeps = defaultNetworkDeps): Promise<JobBriefResult> {
  const role = toNetRole(job);
  if (!deps.hasKey()) return fail("Live briefs are switched off right now.", 503, "model_unavailable", { role });
  if (job.status && job.status !== "open") return fail("This role is no longer open, so there's no brief to write.", 410, "not_found", { role });
  const desc = job.description_text ?? "";
  if (desc.length < MIN_POST) return fail("This listing has too little description to brief from.", 422, "not_a_job_post", { role });
  const used = await deps.briefsToday().catch(() => Infinity);
  if (used >= deps.dailyCap()) return fail("Today's budget for new briefs is used up. Try again tomorrow.", 503, "budget_exhausted", { role });

  let usage: Usage | undefined;
  try {
    const brief = await deps.generate(desc, (u) => (usage = u));
    if (!brief) return fail("This listing doesn't read like a job post, so there's no brief.", 422, "not_a_job_post", { role, usage });
    await deps.countBrief().catch(() => {});
    await deps.save({ role, brief, at: new Date().toISOString() }).catch(() => {});
    return { role, brief, cached: false, ...(usage && { usage }) };
  } catch (err) {
    // Checked by status: errors from the SDK's other build fail instanceof.
    const status = (err as { status?: unknown }).status;
    if (err instanceof Anthropic.RateLimitError || status === 429) return fail("It's busy right now. Try again in a minute.", 503, "model_rate_limited", { role, usage });
    if (err instanceof Anthropic.APIError || typeof status === "number") return fail("Brief generation failed. Try again in a minute.", 502, "model_error", { role, usage });
    throw err;
  }
}
