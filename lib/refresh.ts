import { generateBrief } from "./brief";
import { bundled, type Board, type Brief, type Pay, type Role } from "./data";
import { loadBoard, saveBoard } from "./store";

const API = "https://speedrun-talent-network.com/api/v1";
const SOURCE = "one-link";
const MAX_NEW = 12;
const PARALLEL = 4;

// Board-wide pay with posted ranges (p25, median, p75), from the October 31, 2026 audit.
const BANDS: Record<string, [number, number, number]> = {
  research: [170000, 237500, 275000],
  product: [197875, 225000, 256800],
  engineering: [167500, 201600, 246263],
  design: [144409, 187500, 214700],
  other: [110200, 185000, 207500],
  sales: [140000, 182000, 250000],
  marketing: [152301, 177750, 206963],
  operations: [125000, 158000, 201250],
};

type Job = {
  id: string;
  title: string;
  company: string;
  url: string;
  location: string | null;
  workplace_type: string | null;
  function: string | null;
  comp_min: number | null;
  comp_max: number | null;
  published_at: string | null;
  stealth: boolean;
  status?: string;
  description_text?: string | null;
};

async function getJson(url: string) {
  const res = await fetch(url, { headers: { "user-agent": SOURCE }, signal: AbortSignal.timeout(20000), cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

async function listJobs() {
  const jobs: Job[] = [];
  for (let page = 0; page < 20; page++) {
    const data = await getJson(`${API}/jobs?scope=speedrun&page=${page}&source=${SOURCE}`);
    const batch: Job[] = data.jobs ?? [];
    if (!batch.length) break;
    jobs.push(...batch);
    if (data.total && jobs.length >= data.total) break;
  }
  return jobs;
}

function conflictFor(workplace: string, desc: string) {
  if (workplace === "onsite" && /remote-first|fully remote|100% remote/i.test(desc))
    return "The listing says onsite, but the description mentions remote work. Ask before you plan around either.";
  if (workplace === "remote" && /\b(in[- ]office|on-?site)\b[^.]{0,40}\b(days?|required|five|5)\b/i.test(desc))
    return "The listing says remote, but the description mentions in-office days. Ask before you plan around either.";
  return null;
}

function toRole(job: Job): Role {
  const fn = job.function && BANDS[job.function] ? job.function : "other";
  const [p25, median, p75] = BANDS[fn];
  const pay: Pay = job.comp_min && job.comp_max ? { kind: "posted", min: job.comp_min, max: job.comp_max } : { kind: "estimate", function: fn, p25, median, p75 };
  return {
    id: job.id,
    short: job.id.slice(0, 8),
    title: job.title.trim(),
    company: job.company,
    location: job.location,
    workplace: job.workplace_type,
    function: fn,
    url: job.url,
    posted: (job.published_at ?? "").slice(0, 10),
    ageDays: 0,
    pay,
    conflict: conflictFor((job.workplace_type ?? "").toLowerCase(), job.description_text ?? ""),
    open: true,
  };
}

// A role that can never get a brief is skipped for good. Network and API errors are retried next run.
async function addRole(job: Job, board: Board) {
  const data = await getJson(`${API}/jobs/${job.id}?source=${SOURCE}`);
  const full: Job = data.job ?? data;
  const desc = full.description_text ?? "";
  if (full.status !== "open" || full.stealth || desc.length < 200) return "skipped";
  const generated = await generateBrief(desc);
  if (!generated) return "skipped";
  const { company: _company, title: _title, ...brief } = generated;
  board.briefs[job.id] = brief satisfies Brief;
  board.roles = [...board.roles.filter((r) => r.id !== job.id), toRole(full)];
  return "added";
}

export async function refreshBoard() {
  const prev = (await loadBoard()) ?? bundled;
  const jobs = (await listJobs()).filter((j) => !j.stealth);
  // An empty list means the API failed, not that every role closed.
  if (jobs.length < 20) throw new Error(`Only ${jobs.length} roles listed, keeping the current board`);

  const live = new Set(jobs.map((j) => j.id));
  const board: Board = {
    asOf: new Date().toISOString().slice(0, 10),
    roles: prev.roles.map((r) => ({ ...r, open: live.has(r.id) })),
    briefs: { ...prev.briefs },
    skipped: prev.skipped.filter((id) => live.has(id)),
  };

  const queue = jobs.filter((j) => !board.briefs[j.id] && !board.skipped.includes(j.id)).slice(0, MAX_NEW);
  const result = { added: 0, skipped: 0, failed: 0, waiting: 0 };
  for (let i = 0; i < queue.length; i += PARALLEL) {
    await Promise.all(
      queue.slice(i, i + PARALLEL).map(async (job) => {
        try {
          const outcome = await addRole(job, board);
          result[outcome]++;
          if (outcome === "skipped") board.skipped.push(job.id);
        } catch {
          result.failed++;
        }
      }),
    );
  }
  result.waiting = jobs.filter((j) => !board.briefs[j.id] && !board.skipped.includes(j.id)).length - result.failed;

  board.roles.sort((a, b) => (b.posted ?? "").localeCompare(a.posted ?? ""));
  await saveBoard(board);
  return { ...result, open: board.roles.filter((r) => r.open && board.briefs[r.id]).length, closed: board.roles.filter((r) => !r.open).length };
}
