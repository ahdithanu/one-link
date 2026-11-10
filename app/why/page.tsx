import type { Metadata } from "next";
import Link from "next/link";
import { findRole, getBoard, getOpenRoles } from "@/lib/data";
import { countEvents, EventName } from "@/lib/store";
import { story } from "@/lib/story";

export const metadata: Metadata = { title: "Why I built this · One Link" };
export const revalidate = 300;

const STEPS: { name: EventName; label: string }[] = [
  { name: "visit", label: "Visits" },
  { name: "brief_created", label: "Briefs made from a pasted job" },
  { name: "prebuilt_opened", label: "Speedrun briefs opened" },
  { name: "share_copied", label: "Brief links copied" },
  { name: "link_added", label: "Finished work added" },
  { name: "network_click", label: "Clicks to the talent network" },
  { name: "agent_brief", label: "Briefs fetched by AI agents" },
];

// The speedrun talent team's Product Engineer role.
const OWN_ROLE = "5c268fc2";
const MCP_ADD = "claude mcp add --transport http one-link https://one-link-eta.vercel.app/mcp";

export default async function Why() {
  const [board, roles, own] = await Promise.all([getBoard(), getOpenRoles(), findRole(OWN_ROLE)]);
  const asOf = new Date(`${board.asOf}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const noPay = roles.filter((r) => r.pay.kind !== "posted").length;
  const stale = roles.filter((r) => r.ageDays > 90).length;
  const companies = new Set(roles.map((r) => r.company)).size;
  const pct = (n: number) => `${Math.round((n / roles.length) * 100)}%`;
  const counts = await countEvents();
  const top = counts ? Math.max(1, ...Object.values(counts)) : 1;

  return (
    <main className="why">
      <section className="queue-head">
        <h1>Why I built this</h1>
        <p>AI made applying free, so a resume now says less than ever. A working thing still costs real effort, and it shows a founder how someone thinks. One Link helps anyone make that thing for the job they want.</p>
      </section>

      {story.length > 0 && (
        <section className="section">
          <h2>Where this comes from</h2>
          {story.map((p) => <p key={p}>{p}</p>)}
        </section>
      )}

      {own && (
        <section className="section">
          <h2>Its own brief</h2>
          <p>
            I ran One Link on the {own.role.title} role on the {own.role.company} talent team. It said to build this:{" "}
            <Link href={`/r/${own.role.short}`}>{own.brief.build.title}</Link>. {own.brief.build.pitch}
          </p>
          <p>One Link is my answer to that brief.</p>
          <ul className="good">
            <li>A stranger can use it in under a minute. There&apos;s no signup: paste a job and read the brief.</li>
            <li>It fits what the talent team already runs. It reads the same public jobs API, and it now plugs into their MCP server.</li>
            <li>It&apos;s live, deployed, and refreshes itself every day.</li>
          </ul>
        </section>
      )}

      <section className="section">
        <h2>For AI agents</h2>
        <p>
          One Link is also an MCP server. Add it next to the speedrun talent network&apos;s server, and an agent can find a role with{" "}
          <code>search_jobs</code> and then get its brief with <code>get_build_brief</code>. Both servers use the same job ids, so
          no glue code is needed.
        </p>
        <div className="cmd">{MCP_ADD}</div>
        <p>
          For any job at any company, <code>brief_from_job_post</code> writes a new brief from the description. All three tools
          are public, need no key, and store nothing about the caller.
        </p>
      </section>

      <section className="section">
        <h2>What the board showed</h2>
        <div className="stats">
          <div><strong>{pct(noPay)}</strong><span>of roles post no pay</span></div>
          <div><strong>{pct(stale)}</strong><span>are over 90 days old</span></div>
          <div><strong>{roles.length}</strong><span>roles at {companies} companies</span></div>
        </div>
        <p className="note">From the public speedrun talent network API, as of {asOf}.</p>
        <p>A candidate shouldn&apos;t find out a role has gone quiet after spending a weekend on it. So each brief shows the role&apos;s age and pay first, and only that candidate&apos;s page carries the warning. The network also says a person reads every signup, which can take months. A finished project gives that person something better to read.</p>
      </section>

      <section className="section">
        <h2>The calls I made</h2>
        <ul className="good">
          <li>It works for any job at any company. A tool that only served speedrun roles would be an ad for them.</li>
          <li>The output is a plan to build something, not a better resume. More polished applications would only make the pile bigger.</li>
          <li>Every speedrun brief quotes its job post, checked word for word, so a founder can trust it isn&apos;t generic.</li>
          <li>No signup to read a brief. The talent network comes up once you have something worth sending.</li>
        </ul>
      </section>

      <section className="section">
        <h2>How it helps</h2>
        <ul className="good">
          <li><b>Job seekers</b> get a clear next step for the job they want, with the warning signs up front.</li>
          <li><b>The network</b> grows when someone shares a brief, and it gets people who have already shown their work.</li>
          <li><b>Founders</b> see that candidates here build things, which is a reason to bring their roles here.</li>
        </ul>
      </section>

      <section className="section">
        <h2>What I&apos;m measuring</h2>
        <p>A brief only counts if it leads to finished work, so the number that matters is how many briefs turn into a link.</p>
        {counts ? (
          <ul className="funnel">
            {STEPS.map(({ name, label }) => (
              <li key={name}>
                <span>{label}</span>
                <span className="bar" style={{ width: `${(counts[name] / top) * 100}%` }} />
                <b>{counts[name]}</b>
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">Live counts aren&apos;t available right now.</p>
        )}
        <p className="note">Live anonymous counts since November 1, 2026, updated every five minutes. They include my own testing and store nothing about the person.</p>
      </section>

      <section className="section">
        <h2>What isn&apos;t real yet</h2>
        <ul className="good">
          <li>Finished work is saved in the person&apos;s browser. Nothing reaches a founder or speedrun.</li>
          <li>The founder queue uses made-up sample entries.</li>
          <li>No one at speedrun has seen or approved this.</li>
        </ul>
      </section>
    </main>
  );
}
