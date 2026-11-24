import { NextRequest, NextResponse } from "next/server";
import { clientIp, pageEventLimited } from "@/lib/limit";
import { INTERNAL, isSource } from "@/lib/source";
import { EVENTS, EventName, recordEvent } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  // agent_brief is recorded by the MCP server only.
  if (!EVENTS.includes(body?.name) || body.name === "agent_brief") return new NextResponse(null, { status: 400 });
  if (body.source === INTERNAL) return new NextResponse(null, { status: 204 });
  // Pages cached before source tracking send none; "agent" is reserved for the MCP server.
  const source = isSource(body.source) && body.source !== "agent" ? body.source : "other";
  if (!(await pageEventLimited(clientIp(req.headers)))) await recordEvent(body.name as EventName, source).catch(() => {});
  return new NextResponse(null, { status: 204 });
}
