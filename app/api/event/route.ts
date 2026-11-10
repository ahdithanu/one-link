import { NextRequest, NextResponse } from "next/server";
import { EVENTS, EventName, recordEvent } from "@/lib/store";

export const runtime = "nodejs";

const WINDOW_MS = 60 * 60 * 1000;
const PER_IP = 60;
const hits = new Map<string, number[]>();

function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= PER_IP) return true;
  hits.set(ip, [...recent, now]);
  return false;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  // agent_brief is recorded by the MCP server only.
  if (!EVENTS.includes(body?.name) || body.name === "agent_brief") return new NextResponse(null, { status: 400 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!limited(ip)) await recordEvent(body.name as EventName).catch(() => {});
  return new NextResponse(null, { status: 204 });
}
