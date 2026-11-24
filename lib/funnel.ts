// The site funnel by source and by day, from event rows (lib/store.ts). Pure, so it's unit tested.
import type { EventName, EventRow } from "./store";

export const STEPS: { name: EventName; label: string }[] = [
  { name: "visit", label: "Visits" },
  { name: "brief_created", label: "Briefs made" },
  { name: "prebuilt_opened", label: "Speedrun briefs opened" },
  { name: "share_copied", label: "Links copied" },
  { name: "link_added", label: "Finished work" },
  { name: "network_click", label: "Talent network clicks" },
  { name: "agent_brief", label: "Agent briefs" },
];

export type Counts = Record<EventName, number>;
const zero = (): Counts => Object.fromEntries(STEPS.map((s) => [s.name, 0])) as Counts;

// Share of visits that reached a brief of either kind. Null when there are no visits.
export const briefRate = (c: Counts) => (c.visit ? Math.round(((c.brief_created + c.prebuilt_opened) / c.visit) * 100) : null);

export function funnel(rows: EventRow[], days = 14, now = new Date()) {
  const bySource = new Map<string, Counts>();
  const byDay = new Map<string, Counts>();
  const before = zero();
  const recent = new Set(Array.from({ length: days }, (_, i) => new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10)));
  for (const r of rows) {
    if (!r.day || !r.source) {
      before[r.name]++;
      continue;
    }
    if (!bySource.has(r.source)) bySource.set(r.source, zero());
    bySource.get(r.source)![r.name]++;
    if (recent.has(r.day)) {
      if (!byDay.has(r.day)) byDay.set(r.day, zero());
      byDay.get(r.day)![r.name]++;
    }
  }
  const sources = [...bySource.entries()].map(([source, counts]) => ({ source, counts })).sort((a, b) => b.counts.visit - a.counts.visit || a.source.localeCompare(b.source));
  const daily = [...recent].map((day) => ({ day, counts: byDay.get(day) ?? zero() }));
  return { sources, daily, before };
}
