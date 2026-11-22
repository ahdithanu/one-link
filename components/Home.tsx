"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Brief, RoleListing } from "@/lib/data";
import { BriefView } from "./BriefView";
import { progressLabel, useBriefRequest, type Failure } from "./useBriefRequest";

type Live = Brief & { company: string; title: string };

const PAGE = 30;

function PasteBox({ onBrief }: { onBrief: (b: Live, id: string | null) => void }) {
  const [input, setInput] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const { busy, seconds, send } = useBriefRequest();
  const box = useRef<HTMLTextAreaElement>(null);
  const isLink = /^https?:\/\/\S+$/i.test(input.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    const res = await send<{ brief: Live; id: string | null }>("/api/brief", { input });
    if (!res) return;
    if (res.ok) return onBrief(res.data.brief, res.data.id ?? null);
    setFailure(res.failure);
    // The page couldn't be read: switch to pasting the description, which always works.
    if (res.failure.code === "fetch_failed") {
      setInput("");
      // After the re-render that re-enables the field.
      setTimeout(() => box.current?.focus(), 0);
    }
  }

  return (
    <form className="paste" onSubmit={submit} aria-busy={busy}>
      <label htmlFor="post">Paste any job link or description</label>
      <textarea
        id="post"
        ref={box}
        required
        value={input}
        disabled={busy}
        onChange={(e) => setInput(e.target.value)}
        placeholder={failure?.code === "fetch_failed" ? "Paste the full job description here" : "https://… or the full job post"}
      />
      <div className="row">
        <span className="note" aria-live="polite">
          {busy ? progressLabel(seconds, isLink ? "Fetching the job page…" : "Reading the post…") : "Works for any job at any company. No signup to read your brief."}
        </span>
        <button className="btn" type="submit" disabled={busy}>{busy ? "Working…" : "Get my brief"}</button>
      </div>
      {failure && (
        <p className="error" role="alert">
          {failure.message}
          {failure.code === "rate_limited" && (
            <>
              {" "}
              <a href="#roles">Browse ready-made briefs</a>
            </>
          )}
        </p>
      )}
    </form>
  );
}

type NetRow = { id: string; short: string; title: string; company: string; location: string | null; ageDays: number; payPosted: boolean; buildTitle: string | null };

const NET_FUNCTIONS = ["engineering", "product", "design", "research", "sales", "marketing", "operations", "customer", "finance", "hardware_manufacturing"];

// The whole talent network is too big to send to the browser, so it's searched on the server.
function NetworkBoard() {
  const [q, setQ] = useState("");
  const [fn, setFn] = useState("all");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<NetRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [staleMinutes, setStaleMinutes] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const params = new URLSearchParams({ q: q.trim(), page: String(page) });
    if (fn !== "all") params.set("fn", fn);
    let stale = false;
    setState("loading");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/roles?${params}`);
        const data = await res.json();
        if (stale) return;
        if (!res.ok) throw new Error();
        setRows((prev) => (page === 0 ? data.roles : [...prev, ...data.roles]));
        setTotal(data.total);
        setStaleMinutes(data.staleMinutes ?? null);
        setHasMore(data.hasMore);
        setState("ready");
      } catch {
        if (!stale) setState("error");
      }
    }, page === 0 ? 300 : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, fn, page]);

  return (
    <>
      <div className="controls">
        <input aria-label="Search the network" placeholder="Search role, company or skill" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <div className="chips">
          {["all", ...NET_FUNCTIONS].map((name) => (
            <button key={name} className="chip" type="button" aria-pressed={fn === name} onClick={() => { setFn(name); setPage(0); }}>{name.replace("_", " ")}</button>
          ))}
        </div>
      </div>
      <p className="note">{total === null ? "Searching…" : `${total.toLocaleString()} matching roles. Briefs are written when you ask for one.`}</p>
      {staleMinutes && <p className="note">The talent network isn&apos;t answering right now, so these results are from about {staleMinutes} min ago.</p>}
      {state === "error" && <p className="empty">The talent network didn&apos;t answer. Try again in a minute.</p>}
      {state !== "error" && rows.length === 0 && state === "ready" && <p className="empty">No roles match that search.</p>}
      {rows.length > 0 && (
        <ul className="roles">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={r.buildTitle ? `/r/${r.short}` : `/j/${r.id}`}>
                <span className="t">{r.title}</span>
                <span className="c">{r.company}{r.location ? ` · ${r.location}` : ""} · {r.ageDays}d old{r.payPosted ? "" : " · pay not posted"}</span>
                <span className="b">{r.buildTitle ? `Build: ${r.buildTitle}` : "Get a brief"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {hasMore && state === "ready" && (
        <button className="btn ghost more" type="button" onClick={() => setPage(page + 1)}>Show more</button>
      )}
    </>
  );
}

function Board({ roles }: { roles: RoleListing[] }) {
  const [scope, setScope] = useState<"speedrun" | "network">("speedrun");
  return (
    <section className="board" id="roles">
      <div className="board-head">
        <h2>Or start with a role</h2>
        <div className="chips">
          <button className="chip" type="button" aria-pressed={scope === "speedrun"} onClick={() => setScope("speedrun")}>Speedrun · briefs ready</button>
          <button className="chip" type="button" aria-pressed={scope === "network"} onClick={() => setScope("network")}>Whole talent network</button>
        </div>
      </div>
      {scope === "speedrun" ? <SpeedrunBoard roles={roles} /> : <NetworkBoard />}
    </section>
  );
}

function SpeedrunBoard({ roles }: { roles: RoleListing[] }) {
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
    <>
      <p className="note">{matches.length} of {roles.length} live speedrun roles, briefs ready</p>
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
    </>
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
