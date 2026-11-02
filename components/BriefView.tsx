"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Brief, Pay, Role } from "@/lib/data";
import { saveSend } from "@/lib/sends";
import { track } from "@/lib/track";

const JOIN_URL = "https://speedrun-talent-network.com/join";

const k = (n: number) => `$${Math.round(n / 1000)}k`;

function PayLine({ pay }: { pay: Pay }) {
  if (pay.kind === "posted") return <dd>{k(pay.min)} to {k(pay.max)}, as posted</dd>;
  return (
    <dd>
      Not posted. Across {pay.function} roles on the board with posted pay, the middle half is {k(pay.p25)} to {k(pay.p75)}. That is
      a board-wide range, not this role&apos;s pay.
    </dd>
  );
}

function RoleCard({ role }: { role: Role }) {
  return (
    <div className="card">
      <h3>Before you spend a weekend</h3>
      <dl>
        <dt>Posted</dt>
        <dd>{role.ageDays === 0 ? "Today" : `${role.ageDays} day${role.ageDays === 1 ? "" : "s"} ago`}</dd>
        <dt>Pay</dt>
        <PayLine pay={role.pay} />
        <dt>Where</dt>
        <dd>{[role.location, role.workplace].filter(Boolean).join(" · ") || "Not stated"}</dd>
      </dl>
      {role.ageDays > 90 && <p className="flag">This listing is over 90 days old. Check it&apos;s still open first.</p>}
      {role.conflict && <p className="flag">{role.conflict}</p>}
    </div>
  );
}

function SendCard({ title, company, roleUrl }: { title: string; company: string; roleUrl?: string }) {
  const [link, setLink] = useState("");
  const [state, setState] = useState<"idle" | "bad" | "done">("idle");

  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const url = new URL(link.trim());
      if (url.protocol !== "https:") throw new Error();
      saveSend({ url: url.href, title, company });
      track("link_added");
      setState("done");
    } catch {
      setState("bad");
    }
  }

  return (
    <div className="card">
      <h3>Built it? Send one link.</h3>
      {state === "done" ? (
        <p>Added to the <a href="/founders">founder queue</a>. This prototype saves it in your browser only, so nothing has been sent to anyone.</p>
      ) : (
        <form onSubmit={submit}>
          <label className="note" htmlFor="work">Link to what you built</label>
          <input id="work" type="url" required placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} />
          {state === "bad" && <p className="error">Use a full https:// link.</p>}
          <button className="btn" type="submit">Add to queue</button>
        </form>
      )}
      <div className="links">
        <a className="btn ghost" href={JOIN_URL} target="_blank" rel="noreferrer" onClick={() => track("network_click")}>Join the talent network</a>
        {roleUrl && <a className="btn ghost" href={roleUrl} target="_blank" rel="noreferrer">View the role</a>}
      </div>
    </div>
  );
}

function ShareCard() {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setManual(location.href);
    }
    track("share_copied");
  }
  return (
    <div className="card">
      <h3>Know someone who&apos;d want this?</h3>
      <p className="note">Anyone with the link can read this brief.</p>
      {manual ? (
        <input aria-label="Link to this brief" readOnly value={manual} onFocus={(e) => e.target.select()} />
      ) : (
        <button className="btn ghost" type="button" onClick={copy}>{copied ? "Copied" : "Copy link to this brief"}</button>
      )}
    </div>
  );
}

function Opener({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }
  return (
    <div className="opener">
      <p>{text}</p>
      <button className="btn ghost" type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

export function BriefView({ brief, title, company, role, shareable = true }: { brief: Brief; title: string; company: string; role?: Role; shareable?: boolean }) {
  const prebuilt = Boolean(role);
  useEffect(() => {
    if (prebuilt) track("prebuilt_opened");
  }, [prebuilt]);

  return (
    <article className="brief">
      <div className="brief-head">
        <p className="eyebrow">{[title, company].filter(Boolean).join(" · ")}</p>
        <h1>{brief.build.title}</h1>
        <p className="pitch">{brief.build.pitch}</p>
      </div>
      <div className="layout">
        <div>
          <section className="section">
            <h2>What they need</h2>
            <p>{brief.need}</p>
            {brief.evidence && <p className="quote">From the post: &ldquo;{brief.evidence}&rdquo;</p>}
          </section>
          <section className="section">
            <h2>Your weekend</h2>
            <ol className="plan">
              {brief.plan.map((step) => (
                <li key={step.when}><span className="w">{step.when}</span><span>{step.do}</span></li>
              ))}
            </ol>
          </section>
          <section className="section">
            <h2>What makes it good</h2>
            <ul className="good">{brief.good.map((g) => <li key={g}>{g}</li>)}</ul>
          </section>
          <section className="section">
            <h2>How this falls flat</h2>
            <p>{brief.avoid}</p>
          </section>
          <section className="section">
            <h2>Your first line</h2>
            <Opener text={brief.opener} />
          </section>
        </div>
        <aside className="side">
          {role && <RoleCard role={role} />}
          <SendCard title={title} company={company} roleUrl={role?.url} />
          {shareable && <ShareCard />}
        </aside>
      </div>
    </article>
  );
}
