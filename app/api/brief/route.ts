import { NextRequest, NextResponse } from "next/server";
import { clientIp, limited, PER_IP } from "@/lib/limit";
import { makeBrief } from "@/lib/make-brief";

export const runtime = "nodejs";
export const maxDuration = 60;

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) return fail("Live briefs are switched off right now. Pick a role from the list instead.", 503);
  if (limited(clientIp(req.headers))) return fail(`You've hit the limit of ${PER_IP} briefs an hour. Try again later or pick a role from the list.`, 429);

  const body = await req.json().catch(() => null);
  const result = await makeBrief(body?.input);
  if ("error" in result) return fail(result.error, result.status);
  return NextResponse.json(result);
}
