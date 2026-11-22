import { NextRequest, NextResponse } from "next/server";
import { getBoard } from "@/lib/data";
import { clientIp, limited, PER_IP } from "@/lib/limit";
import { lookupJobBrief, writeJobBrief } from "@/lib/network";

export const runtime = "nodejs";
export const maxDuration = 60;

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id.trim().toLowerCase() : "";
  const found = await lookupJobBrief(id, await getBoard());
  if (found.kind === "invalid" || found.kind === "missing") return fail("That role isn't on the talent network.", 404);
  if (found.kind === "board" || found.kind === "saved") return NextResponse.json({ brief: found.brief });
  if (found.kind === "pending") {
    // Someone else's request is writing this brief right now: wait for it instead of paying twice.
    const joined = await writeJobBrief(found.job);
    return "error" in joined ? fail(joined.error, joined.status) : NextResponse.json({ brief: joined.brief });
  }
  // Only a new brief costs a model call, so only it counts toward the hourly limit.
  if (!process.env.ANTHROPIC_API_KEY) return fail("Live briefs are switched off right now.", 503);
  if (await limited(clientIp(req.headers))) return fail(`You've hit the limit of ${PER_IP} new briefs an hour. Try again later.`, 429);
  const result = await writeJobBrief(found.job);
  if ("error" in result) return fail(result.error, result.status);
  return NextResponse.json({ brief: result.brief });
}
