import { NextRequest, NextResponse } from "next/server";
import { clientIp, limited, PER_IP } from "@/lib/limit";
import { logWeb, type Usage } from "@/lib/log";
import { checkInput, makeBrief } from "@/lib/make-brief";
import { INTERNAL, isSource } from "@/lib/source";
import { readCapped } from "@/lib/mcp-http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const started = performance.now();
  // `code` lets the page react (offer the paste box, say when to retry) without parsing messages.
  // Every outcome is logged: route, status, category, duration and token usage, never the input.
  const fail = (error: string, status: number, code: string, usage?: Usage) => {
    logWeb("/api/brief", started, status, code, usage);
    return NextResponse.json({ error, code }, { status });
  };
  if (!process.env.ANTHROPIC_API_KEY) return fail("Live briefs are switched off right now. Pick a role from the list instead.", 503, "model_unavailable");
  // Body is at most a 20,000-character post plus JSON. Read at most 64 KB whatever Content-Length
  // says, so a chunked body can't be buffered whole.
  if (Number(req.headers.get("content-length") ?? 0) > 64 * 1024) return fail("That's too long. Paste just the job description.", 413, "payload_too_large");
  const raw = await readCapped(req.body, 64 * 1024);
  if (Buffer.byteLength(raw) > 64 * 1024) return fail("That's too long. Paste just the job description.", 413, "payload_too_large");
  const body = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  // Validate first, so a malformed request never uses up the caller's hourly allowance.
  const invalid = checkInput(body?.input);
  if (invalid) return fail(invalid.error, invalid.status, invalid.category);
  if (await limited(clientIp(req.headers)))
    return fail(`You've used your ${PER_IP} new briefs for this hour. Pick a ready-made role from the list, or try again later.`, 429, "rate_limited");

  const src = req.headers.get("x-one-link-source");
  const result = await makeBrief(body.input, undefined, src === INTERNAL ? null : isSource(src) && src !== "agent" ? src : "other");
  if ("error" in result) return fail(result.error, result.status, result.category, result.usage);
  logWeb("/api/brief", started, 200, undefined, result.usage);
  return NextResponse.json({ brief: result.brief, id: result.id });
}
