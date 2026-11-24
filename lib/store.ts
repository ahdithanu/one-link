import { randomBytes, randomUUID } from "node:crypto";
import { get, list, put } from "@vercel/blob";
import type { GeneratedBrief } from "./brief";
import type { Board } from "./data";
import { isSource, type Source } from "./source";

export const EVENTS = ["visit", "brief_created", "prebuilt_opened", "share_copied", "link_added", "network_click", "agent_brief"] as const;
export type EventName = (typeof EVENTS)[number];

const write = { access: "private", addRandomSuffix: false } as const;

// Only the generated brief is kept, never the pasted post.
export async function saveBrief(brief: GeneratedBrief) {
  const id = randomBytes(9).toString("base64url");
  await put(`briefs/${id}.json`, JSON.stringify(brief), { ...write, contentType: "application/json" });
  return id;
}

export async function loadBrief(id: string): Promise<GeneratedBrief | null> {
  if (!/^[\w-]{12}$/.test(id)) return null;
  const blob = await get(`briefs/${id}.json`, { access: "private" }).catch(() => null);
  if (!blob || blob.statusCode !== 200) return null;
  return new Response(blob.stream).json();
}

const BOARD = "board/latest.json";

export async function saveBoard(board: Board) {
  await put(BOARD, JSON.stringify(board), { ...write, contentType: "application/json", allowOverwrite: true, cacheControlMaxAge: 60 });
}

export async function loadBoard(): Promise<Board | null> {
  // Skip the CDN copy so pages rebuilt right after a refresh see it.
  const blob = await get(BOARD, { access: "private", useCache: false }).catch(() => null);
  if (!blob || blob.statusCode !== 200) return null;
  return new Response(blob.stream).json();
}

// One small file per event, holding nothing about the person. Since 2026-11-24 the path also has
// the day and the visitor's source bucket (lib/source.ts): events/<name>/<day>/<source>/<uuid>.
// Older events are events/<name>/<uuid> and count as "before tracking".
export const eventPath = (name: EventName, source: Source, day = new Date().toISOString().slice(0, 10), id: string = randomUUID()) =>
  `events/${name}/${day}/${source}/${id}`;

export async function recordEvent(name: EventName, source: Source = "direct") {
  await put(eventPath(name, source), "1", { ...write, contentType: "text/plain" });
}

export type EventRow = { name: EventName; day: string | null; source: Source | null };

// Reads one event path back. Unknown shapes return null and are ignored.
export function parseEventPath(pathname: string): EventRow | null {
  const p = pathname.split("/");
  if (p[0] !== "events" || !EVENTS.includes(p[1] as EventName)) return null;
  const name = p[1] as EventName;
  if (p.length === 3) return { name, day: null, source: null };
  if (p.length === 5 && /^\d{4}-\d{2}-\d{2}$/.test(p[2]) && isSource(p[3])) return { name, day: p[2], source: p[3] };
  return null;
}

export async function listEvents(): Promise<EventRow[] | null> {
  const rows: EventRow[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: "events/", limit: 1000, cursor });
      for (const b of page.blobs) {
        const r = parseEventPath(b.pathname);
        if (r) rows.push(r);
      }
      cursor = page.cursor;
    } while (cursor);
    return rows;
  } catch {
    return null;
  }
}

export async function countEvents(): Promise<Record<EventName, number> | null> {
  const rows = await listEvents();
  if (!rows) return null;
  const counts = Object.fromEntries(EVENTS.map((e) => [e, 0])) as Record<EventName, number>;
  for (const r of rows) counts[r.name]++;
  return counts;
}
