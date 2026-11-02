"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import type { Brief, RoleListing } from "@/lib/data";
import { BriefView } from "./BriefView";

type Live = Brief & { company: string; title: string };

const PAGE = 30;

function PasteBox({ onBrief }: { onBrief: (b: Live, id: string | null) => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Something went wrong. Try again.");
      else onBrief(data.brief, data.id ?? null);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="paste" onSubmit={submit}>
      <label htmlFor="post">Paste any job link or description</label>
      <textarea id="post" required value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://… or the full job post" />
      <div className="row">
        <span className="note">Works for any job at any company. No signup to read your brief.</span>
        <button className="btn" type="submit" disabled={busy}>{busy ? "Reading the post…" : "Get my brief"}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function Board({ roles }: { roles: RoleListing[] }) {
  const [q, setQ] = useState("");
  const [fn, setFn] = useState("all");
  const [shown, setShown] = useState(PAGE);

  const functions = useMemo(() => {
    const counts = new Map<string, number>();
    roles.forEach((r) => counts.set(r.function, (counts.get(r.function) ?? 0) + 1));
    return [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [roles]);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return roles.filter(
      (r) => (fn === "all" || r.function === fn) && (!needle || `${r.title} ${r.company} ${r.location ?? ""}`.toLowerCase().includes(needle)),
    );
  }, [roles, q, fn]);

  return (
    <section className="board" id="roles">
      <div className="board-head">
        <h2>Or start with a speedrun role</h2>
        <span className="note">{matches.length} of {roles.length} live roles, briefs ready</span>
      </div>
      <div className="controls">
        <input aria-label="Search roles" placeholder="Search role, company or city" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} />
        <div className="chips">
          {["all", ...functions].map((name) => (
            <button key={name} className="chip" type="button" aria-pressed={fn === name} onClick={() => { setFn(name); setShown(PAGE); }}>{name}</button>
          ))}
        </div>
      </div>
      {matches.length === 0 ? (
        <p className="empty">No roles match that search.</p>
      ) : (
        <ul className="roles">
          {matches.slice(0, shown).map((r) => (
            <li key={r.id}>
              <Link href={`/r/${r.short}`}>
                <span className="t">{r.title}</span>
                <span className="c">{r.company}{r.location ? ` · ${r.location}` : ""}</span>
                <span className="b">Build: {r.buildTitle}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {shown < matches.length && (
        <button className="btn ghost more" type="button" onClick={() => setShown(shown + PAGE)}>Show more</button>
      )}
    </section>
  );
}

export function Home({ roles }: { roles: RoleListing[] }) {
  const [live, setLive] = useState<Live | null>(null);
  const router = useRouter();

  if (live) {
    return (
      <main>
        <button className="btn ghost" type="button" style={{ marginTop: 16 }} onClick={() => setLive(null)}>Start over</button>
        <BriefView brief={live} title={live.title} company={live.company} shareable={false} />
      </main>
    );
  }

  return (
    <main>
      <section className="hero">
        <h1>Skip the resume pile.</h1>
        <p className="lede">Tell us the job. We&apos;ll tell you the one thing to build this weekend that makes the founder reply, then you send one link.</p>
      </section>
      <PasteBox onBrief={(brief, id) => (id ? router.push(`/b/${id}`) : setLive(brief))} />
      <Board roles={roles} />
    </main>
  );
}
