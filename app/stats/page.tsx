import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getRedis } from "@/lib/limit";
import { countEvents, EventName } from "@/lib/store";
import { sessionValid, STATS_COOKIE, statsKey } from "@/lib/stats-auth";
import { readUsage } from "@/lib/usage";

export const metadata: Metadata = { title: "Stats · One Link", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const EVENT_LABELS: { name: EventName; label: string }[] = [
  { name: "visit", label: "Page visits" },
  { name: "brief_created", label: "Briefs made from a pasted job" },
  { name: "prebuilt_opened", label: "Speedrun briefs opened" },
  { name: "share_copied", label: "Brief links copied" },
  { name: "link_added", label: "Finished work added" },
  { name: "network_click", label: "Clicks to the talent network" },
  { name: "agent_brief", label: "Briefs fetched by AI agents" },
];

const sum = (rows: Record<string, number>[]) =>
  rows.reduce<Record<string, number>>((acc, r) => {
    for (const [k, v] of Object.entries(r)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});
const sorted = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1]);

export default async function Stats({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const key = statsKey();
  if (!key) notFound();
  const { e } = await searchParams;

  if (!sessionValid((await cookies()).get(STATS_COOKIE)?.value, key))
    return (
      <main className="why stats">
        <section className="queue-head">
          <h1>Stats</h1>
          <p>Private. Enter the key set as STATS_KEY in Vercel.</p>
        </section>
        <form className="stats-login" method="post" action="/api/stats-login">
          <input type="password" name="key" autoComplete="current-password" aria-label="Stats key" required />
          <button type="submit">Open</button>
        </form>
        {e === "wrong" && <p className="note" role="status">That key didn&apos;t match.</p>}
        {e === "limit" && <p className="note" role="status">Too many tries. Wait an hour.</p>}
      </main>
    );

  const redis = getRedis();
  const [usage, events] = await Promise.all([redis ? readUsage(redis, 30).catch(() => null) : Promise.resolve(null), countEvents()]);
  const tools = sorted(sum(usage?.days.map((d) => d.tools) ?? []));
  const clients = sorted(sum(usage?.days.map((d) => d.clients) ?? []));
  const total = (k: "calls" | "errors" | "connects") => usage?.days.reduce((a, d) => a + d[k], 0) ?? 0;

  return (
    <main className="why stats">
      <section className="queue-head">
        <h1>Stats</h1>
        <p>
          Agent (MCP) usage from Redis, site events from Blob. Visitors, pages, referrers and countries are in{" "}
          <a href="https://vercel.com/ahdi-s-projects/one-link/analytics">Vercel Web Analytics</a>.
        </p>
      </section>

      {!redis && (
        <section className="section">
          <h2>Agent usage</h2>
          <p>Not recording: Redis isn&apos;t connected. Connect Upstash in Vercel (Storage) and redeploy, and counts start from then.</p>
        </section>
      )}
      {redis && !usage && (
        <section className="section">
          <h2>Agent usage</h2>
          <p>Couldn&apos;t read from Redis just now. Reload in a minute.</p>
        </section>
      )}

      {usage && (
        <>
          <section className="section">
            <h2>Unique MCP callers</h2>
            <dl className="stat-tiles">
              <div><dt>Today</dt><dd>{usage.days[0].callers}</dd></div>
              <div><dt>Last 7 days</dt><dd>{usage.uniqueCallers.week}</dd></div>
              <div><dt>Last 30 days</dt><dd>{usage.uniqueCallers.period}</dd></div>
              <div><dt>All time</dt><dd>{usage.uniqueCallers.allTime}</dd></div>
            </dl>
            <p className="note">
              {usage.uniqueCallers.periodToolCallers} of the last 30 days&apos; callers made at least one tool call. A caller is one network
              address, counted without storing it. Estimates, accurate to about 1%.
            </p>
          </section>

          <section className="section">
            <h2>Last 30 days</h2>
            <dl className="stat-tiles">
              <div><dt>Tool calls</dt><dd>{total("calls")}</dd></div>
              <div><dt>Failed calls</dt><dd>{total("errors")}</dd></div>
              <div><dt>Connections</dt><dd>{total("connects")}</dd></div>
            </dl>
          </section>

          <section className="section">
            <h2>By tool</h2>
            {tools.length ? (
              <table className="stats-table">
                <tbody>{tools.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody>
              </table>
            ) : <p>No tool calls yet.</p>}
          </section>

          <section className="section">
            <h2>By client</h2>
            {clients.length ? (
              <table className="stats-table">
                <tbody>{clients.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody>
              </table>
            ) : <p>No connections yet.</p>}
            <p className="note">From the name each client sends when it connects.</p>
          </section>

          <section className="section">
            <h2>Daily</h2>
            <table className="stats-table">
              <thead><tr><th>Day</th><th>Callers</th><th>Tool calls</th><th>Failed</th></tr></thead>
              <tbody>
                {usage.days.map((d) => (
                  <tr key={d.day}><td>{d.day}</td><td>{d.callers}</td><td>{d.calls}</td><td>{d.errors}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <section className="section">
        <h2>Site events, all time</h2>
        {events ? (
          <table className="stats-table">
            <tbody>{EVENT_LABELS.map(({ name, label }) => <tr key={name}><td>{label}</td><td>{events[name]}</td></tr>)}</tbody>
          </table>
        ) : <p>Couldn&apos;t read events just now.</p>}
      </section>
    </main>
  );
}
