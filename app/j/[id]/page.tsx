import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BriefView } from "@/components/BriefView";
import { JobPending } from "@/components/JobPending";
import { getBoard } from "@/lib/data";
import { lookupJobBrief, toNetRole } from "@/lib/network";

type Props = { params: Promise<{ id: string }> };

// Rendered per request: the brief may have been written a moment ago.
export const dynamic = "force-dynamic";

async function load(id: string) {
  return lookupJobBrief(id.toLowerCase(), await getBoard());
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await load((await params).id);
  if (found.kind === "saved") return { title: `${found.brief.build.title} · One Link` };
  if (found.kind === "new") return { title: `${found.job.title} at ${found.job.company} · One Link` };
  return {};
}

export default async function JobPage({ params }: Props) {
  const found = await load((await params).id);
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
