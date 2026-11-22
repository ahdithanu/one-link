import { NextRequest, NextResponse } from "next/server";
import { clientIp, limited, PER_IP } from "@/lib/limit";
import { checkInput, makeBrief } from "@/lib/make-brief";

export const runtime = "nodejs";
export const maxDuration = 60;

// `code` lets the page react (offer the paste box, say when to retry) without parsing messages.
const fail = (error: string, status: number, code: string) => NextResponse.json({ error, code }, { status });

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) return fail("Live briefs are switched off right now. Pick a role from the list instead.", 503, "model_unavailable");
  // Body is at most a 20,000-character post plus JSON, so anything far larger is refused unread.
  if (Number(req.headers.get("content-length") ?? 0) > 64 * 1024) return fail("That's too long. Paste just the job description.", 413, "payload_too_large");
  const body = await req.json().catch(() => null);
  // Validate first, so a malformed request never uses up the caller's hourly allowance.
  const invalid = checkInput(body?.input);
  if (invalid) return fail(invalid.error, invalid.status, invalid.category);
  if (await limited(clientIp(req.headers)))
    return fail(`You've used your ${PER_IP} new briefs for this hour. Pick a ready-made role from the list, or try again later.`, 429, "rate_limited");

  const result = await makeBrief(body.input);
  if ("error" in result) return fail(result.error, result.status, result.category);
  return NextResponse.json({ brief: result.brief, id: result.id });
}
