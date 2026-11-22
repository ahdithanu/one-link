import { NextRequest, NextResponse } from "next/server";
import { getBoard } from "@/lib/data";
import { clientIp, limited, PER_IP } from "@/lib/limit";
import { logWeb, type Usage } from "@/lib/log";
import { lookupJobBrief, writeJobBrief } from "@/lib/network";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const started = performance.now();
  const fail = (error: string, status: number, code: string, usage?: Usage) => {
    logWeb("/api/job-brief", started, status, code, usage);
    return NextResponse.json({ error, code }, { status });
  };
  const ok = (brief: unknown, usage?: Usage) => {
    logWeb("/api/job-brief", started, 200, undefined, usage);
    return NextResponse.json({ brief });
  };
  if (Number(req.headers.get("content-length") ?? 0) > 4 * 1024) return fail("Bad request.", 413, "payload_too_large");
  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id.trim().toLowerCase() : "";
  const found = await lookupJobBrief(id, await getBoard());
  if (found.kind === "invalid" || found.kind === "missing") return fail("That role isn't on the talent network.", 404, "not_found");
  if (found.kind === "board" || found.kind === "saved") return ok(found.brief);
  if (found.kind === "pending") {
    // Someone else's request is writing this brief right now: wait for it instead of paying twice.
    const joined = await writeJobBrief(found.job);
    return "error" in joined ? fail(joined.error, joined.status, joined.category) : ok(joined.brief);
  }
  // Only a new brief costs a model call, so only it counts toward the hourly limit.
  if (!process.env.ANTHROPIC_API_KEY) return fail("Live briefs are switched off right now.", 503, "model_unavailable");
  if (await limited(clientIp(req.headers))) return fail(`You've used your ${PER_IP} new briefs for this hour. Try again later.`, 429, "rate_limited");
  const result = await writeJobBrief(found.job);
  if ("error" in result) return fail(result.error, result.status, result.category, result.usage);
  return ok(result.brief, result.usage);
}
