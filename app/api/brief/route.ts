import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { generateBrief } from "@/lib/brief";
import { fetchJobPost } from "@/lib/fetch-post";
import { recordEvent, saveBrief } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

const WINDOW_MS = 60 * 60 * 1000;
const PER_IP = 5;
const hits = new Map<string, number[]>();

// Per-instance limit. The Anthropic workspace spend cap is the hard ceiling.
function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= PER_IP) return true;
  hits.set(ip, [...recent, now]);
  return false;
}

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) return fail("Live briefs are switched off right now. Pick a role from the list instead.", 503);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (limited(ip)) return fail("You've hit the limit of 5 briefs an hour. Try again later or pick a role from the list.", 429);

  const body = await req.json().catch(() => null);
  const input = typeof body?.input === "string" ? body.input.trim() : "";
  if (input.length < 12) return fail("Paste a job link or the full job description.", 400);
  if (input.length > 20000) return fail("That's too long. Paste just the job description.", 400);

  let post = input;
  if (/^https?:\/\/\S+$/i.test(input)) {
    const fetched = await fetchJobPost(input).catch(() => null);
    if (!fetched) return fail("That page wouldn't load for us. Paste the job description instead.", 422);
    post = fetched;
  } else if (input.length < 200) {
    return fail("That's too short to be a full job description. Paste the whole post.", 400);
  }

  try {
    const brief = await generateBrief(post);
    if (!brief) return fail("That doesn't look like a job post. Paste the full description.", 422);
    const id = await saveBrief(brief).catch(() => null);
    await recordEvent("brief_created").catch(() => {});
    return NextResponse.json({ brief, id });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return fail("It's busy right now. Try again in a minute.", 503);
    if (err instanceof Anthropic.APIError) return fail("Brief generation failed. Try again in a minute.", 502);
    throw err;
  }
}
