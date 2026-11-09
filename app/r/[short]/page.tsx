import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BriefView } from "@/components/BriefView";
import { bundled, findRole } from "@/lib/data";

type Props = { params: Promise<{ short: string }> };

export const revalidate = 3600;

export function generateStaticParams() {
  return bundled.roles.map((r) => ({ short: r.short }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await findRole((await params).short);
  return found ? { title: `${found.brief.build.title} · One Link` } : {};
}

export default async function RolePage({ params }: Props) {
  const found = await findRole((await params).short);
  if (!found) notFound();
  return (
    <main>
      <BriefView brief={found.brief} title={found.role.title} company={found.role.company} role={found.role} />
    </main>
  );
}
