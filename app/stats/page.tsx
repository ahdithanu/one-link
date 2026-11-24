import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getRedis } from "@/lib/limit";
import { MarkInternal } from "@/components/MarkInternal";
import { briefRate, funnel, STEPS } from "@/lib/funnel";
import { listEvents } from "@/lib/store";
import { sessionValid, STATS_COOKIE, statsKey } from "@/lib/stats-auth";
import { readUsage } from "@/lib/usage";

export const metadata: Metadata = { title: "Stats · One Link", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";


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
  const [usage, eventRows] = await Promise.all([redis ? readUsage(redis, 30).catch(() => null) : Promise.resolve(null), listEvents()]);
  const tools = sorted(sum(usage?.days.map((d) => d.tools) ?? []));
  const clients = sorted(sum(usage?.days.map((d) => d.clients) ?? []));
  const site = eventRows ? funnel(eventRows, 14) : null;
  const pct = (n: number | null) => (n === null ? "–" : `${n}%`);
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
        <h2>Site funnel by source</h2>
        {site ? (
          <>
            <div className="stats-scroll">
              <table className="stats-table">
                <thead><tr><th>Source</th>{STEPS.map((st) => <th key={st.name}>{st.label}</th>)}<th>Visit → brief</th></tr></thead>
                <tbody>
                  {site.sources.map(({ source, counts }) => (
                    <tr key={source}><td>{source}</td>{STEPS.map((st) => <td key={st.name}>{counts[st.name]}</td>)}<td>{pct(briefRate(counts))}</td></tr>
                  ))}
                  <tr className="muted"><td>before tracking</td>{STEPS.map((st) => <td key={st.name}>{site.before[st.name]}</td>)}<td>{pct(briefRate(site.before))}</td></tr>
                </tbody>
              </table>
            </div>
            <p className="note">
              Source is where a browser session first came from: utm_source if the link had one, otherwise the referring site. Events from
              before November 24, 2026 have no source or date. &ldquo;Visit → brief&rdquo; counts briefs made plus speedrun briefs opened, per visit.
            </p>
          </>
        ) : <p>Couldn&apos;t read events just now.</p>}
      </section>

      {site && (
        <section className="section">
          <h2>Site funnel, last 14 days</h2>
          <div className="stats-scroll">
            <table className="stats-table">
              <thead><tr><th>Day</th>{STEPS.map((st) => <th key={st.name}>{st.label}</th>)}</tr></thead>
              <tbody>
                {site.daily.map(({ day, counts }) => (
                  <tr key={day}><td>{day}</td>{STEPS.map((st) => <td key={st.name}>{counts[st.name]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <MarkInternal />
    </main>
  );
}
