import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { refreshBoard } from "@/lib/refresh";

export const runtime = "nodejs";
export const maxDuration = 300;

const digest = (s: string) => createHash("sha256").update(s).digest();

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization") ?? "";
  if (!secret || !timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return new NextResponse(null, { status: 401 });
  try {
    const result = await refreshBoard();
    revalidatePath("/");
    revalidatePath("/why");
    revalidatePath("/r/[short]", "page");
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Refresh failed" }, { status: 500 });
  }
}
