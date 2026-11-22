import { NextRequest, NextResponse } from "next/server";
import { getBoard } from "@/lib/data";
import { clientIp, searchLimited } from "@/lib/limit";
import { searchNetwork } from "@/lib/network";

export const runtime = "nodejs";

// Search-as-you-type calls this often, so the limit (600 an hour per caller) is generous.
// Results are cached per instance.

export async function GET(req: NextRequest) {
  if (await searchLimited(clientIp(req.headers))) return NextResponse.json({ error: "Too many searches. Wait a minute." }, { status: 429 });
  const p = req.nextUrl.searchParams;
  try {
    const [found, board] = await Promise.all([
      searchNetwork({ q: p.get("q") ?? "", fn: p.get("fn") ?? "", page: Number(p.get("page")) || 0 }),
      getBoard(),
    ]);
    const roles = found.roles.map((r) => ({
      id: r.id,
      short: r.short,
      title: r.title,
      company: r.company,
      location: r.location,
      ageDays: r.ageDays,
      payPosted: r.pay.kind === "posted",
      buildTitle: board.briefs[r.id]?.build.title ?? null,
    }));
    return NextResponse.json({ total: found.total, page: found.page, hasMore: found.hasMore, roles });
  } catch {
    return NextResponse.json({ error: "The talent network didn't answer. Try again in a minute." }, { status: 502 });
  }
}
