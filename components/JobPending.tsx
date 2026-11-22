"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { NetRole } from "@/lib/network";
import { RoleCard } from "./BriefView";

// A network role without a brief yet: show the facts first, write the brief only when asked.
export function JobPending({ role }: { role: NetRole }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function write() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/job-brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: role.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error ?? "Something went wrong. Try again.");
      else router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="brief">
      <div className="brief-head">
        <p className="eyebrow">{role.title} · {role.company}</p>
        <h1>No brief for this role yet</h1>
        <p className="pitch">Check the facts below first. If it&apos;s worth a weekend, we&apos;ll read the listing and write the brief. It takes about 20 seconds.</p>
      </div>
      <div className="layout">
        <div>
          <button className="btn" type="button" onClick={write} disabled={busy}>{busy ? "Reading the listing…" : "Write my brief"}</button>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <aside className="side">
          <RoleCard role={role} />
          <a className="btn ghost" href={role.url} target="_blank" rel="noreferrer">View the role</a>
        </aside>
      </div>
    </article>
  );
}
