import { randomBytes, randomUUID } from "node:crypto";
import { get, list, put } from "@vercel/blob";
import type { GeneratedBrief } from "./brief";
import type { Board } from "./data";

export const EVENTS = ["visit", "brief_created", "prebuilt_opened", "share_copied", "link_added", "network_click"] as const;
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

// One small file per event, holding nothing about the person.
export async function recordEvent(name: EventName) {
  await put(`events/${name}/${randomUUID()}`, "1", { ...write, contentType: "text/plain" });
}

export async function countEvents(): Promise<Record<EventName, number> | null> {
  const counts = Object.fromEntries(EVENTS.map((e) => [e, 0])) as Record<EventName, number>;
  try {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: "events/", limit: 1000, cursor });
      for (const b of page.blobs) {
        const name = b.pathname.split("/")[1] as EventName;
        if (name in counts) counts[name]++;
      }
      cursor = page.cursor;
    } while (cursor);
    return counts;
  } catch {
    return null;
  }
}
