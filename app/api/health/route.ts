import { NextResponse } from "next/server";
import { healthReport, type Health } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cached briefly so this public endpoint can't be used to spend Redis commands.
let cached: { at: number; body: Promise<Health> } | null = null;

export async function GET() {
  if (!cached || Date.now() - cached.at > 15_000) {
    const body = healthReport();
    cached = { at: Date.now(), body };
    body.catch(() => (cached = null));
  }
  return NextResponse.json(await cached.body, { headers: { "cache-control": "no-store" } });
}
