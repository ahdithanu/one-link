import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BriefView } from "@/components/BriefView";
import { loadBrief } from "@/lib/store";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const brief = await loadBrief((await params).id);
  return { title: brief ? `${brief.build.title} · One Link` : "One Link", robots: { index: false } };
}

export default async function SavedBrief({ params }: Props) {
  const brief = await loadBrief((await params).id);
  if (!brief) notFound();
  return (
    <main>
      <BriefView brief={brief} title={brief.title} company={brief.company} />
    </main>
  );
}
