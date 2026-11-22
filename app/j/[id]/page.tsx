import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { BriefView } from "@/components/BriefView";
import { JobPending } from "@/components/JobPending";
import { getBoard } from "@/lib/data";
import { clientIp, upstreamLimited } from "@/lib/limit";
import { lookupJobBrief, toNetRole } from "@/lib/network";

type Props = { params: Promise<{ id: string }> };

// Rendered per request: the brief may have been written a moment ago.
export const dynamic = "force-dynamic";

// One lookup per request, shared by the metadata and the page. Each unknown id is a talent network
// call, so it counts against the caller's upstream budget first.
const load = cache(async (id: string) => {
  if (await upstreamLimited(clientIp(await headers()))) return { kind: "limited" as const };
  return lookupJobBrief(id.toLowerCase(), await getBoard());
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await load((await params).id);
  if (found.kind === "saved") return { title: `${found.brief.build.title} · One Link` };
  if (found.kind === "new") return { title: `${found.job.title} at ${found.job.company} · One Link` };
  return {};
}

export default async function JobPage({ params }: Props) {
  const found = await load((await params).id);
  if (found.kind === "limited")
    return (
      <main>
        <p className="empty">Too many requests from your connection. Try again in a few minutes.</p>
      </main>
    );
  if (found.kind === "board") redirect(`/r/${found.role.short}`);
  if (found.kind === "invalid" || found.kind === "missing") notFound();
  if (found.kind === "saved")
    return (
      <main>
        <BriefView brief={found.brief} title={found.role.title} company={found.role.company} role={found.role} />
      </main>
    );
  return (
    <main>
      <JobPending role={toNetRole(found.job)} />
    </main>
  );
}
