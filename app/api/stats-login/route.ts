import { NextRequest, NextResponse } from "next/server";
import { clientIp, statsLoginLimited } from "@/lib/limit";
import { keyMatches, sessionValue, STATS_COOKIE, statsKey } from "@/lib/stats-auth";

export const runtime = "nodejs";

// A plain form post, so the key never appears in a URL, a log line or browser history.
export async function POST(req: NextRequest) {
  const key = statsKey();
  if (!key) return new NextResponse(null, { status: 404 });
  const back = (q: string) => NextResponse.redirect(new URL(`/stats${q}`, req.nextUrl.origin), 303);
  if (await statsLoginLimited(clientIp(req.headers))) return back("?e=limit");
  const form = await req.formData().catch(() => null);
  if (!keyMatches(form?.get("key"), key)) return back("?e=wrong");
  const res = back("");
  res.cookies.set(STATS_COOKIE, sessionValue(key), { httpOnly: true, secure: true, sameSite: "strict", path: "/stats", maxAge: 30 * 24 * 3600 });
  return res;
}
