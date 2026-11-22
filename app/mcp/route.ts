import { NextRequest, NextResponse } from "next/server";
import { clientIp, eventLimited, limited } from "@/lib/limit";
import { CORS, handleMcp, progressToken, readCapped, streamMcp } from "@/lib/mcp-http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const raw = await readCapped(req.body);
  const ctx = { origin: req.nextUrl.origin, limited: () => limited(ip), eventLimited: () => eventLimited(ip) };
  // A slow tool call that asked for progress gets an SSE stream; everything else is plain JSON.
  const token = progressToken(raw, req.headers);
  if (token !== null)
    return new Response(streamMcp(raw, req.headers, ctx, token), {
      status: 200,
      headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
    });
  const { status, body } = await handleMcp(raw, req.headers, ctx);
  // After a 413 the rest of the body is unread, so the connection can't be reused.
  const headers = status === 413 ? { ...CORS, connection: "close" } : CORS;
  if (body === null) return new NextResponse(null, { status, headers });
  return NextResponse.json(body, { status, headers });
}

// No server-to-client stream and no sessions.
export function GET() {
  return new NextResponse(null, { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } });
}

export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
