import { NextRequest, NextResponse } from "next/server";
import { clientIp, eventLimited, limited } from "@/lib/limit";
import { CORS, handleMcp, readCapped } from "@/lib/mcp-http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const raw = await readCapped(req.body);
  const { status, body } = await handleMcp(raw, req.headers, {
    origin: req.nextUrl.origin,
    limited: () => limited(ip),
    eventLimited: () => eventLimited(ip),
  });
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
