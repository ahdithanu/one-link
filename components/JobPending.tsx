"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { NetRole } from "@/lib/network";
import { RoleCard } from "./BriefView";
import { progressLabel, useBriefRequest, type Failure } from "./useBriefRequest";

// A network role without a brief yet: show the facts first, write the brief only when asked.
export function JobPending({ role }: { role: NetRole }) {
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);
  const { busy, seconds, send } = useBriefRequest();

  async function write(retries = 2): Promise<void> {
    setFailure(null);
    const res = await send<{ brief: unknown }>("/api/job-brief", { id: role.id });
    if (!res) return;
    // Saved on the server, so reloading the page shows it (and shares it with everyone).
    if (res.ok) return router.refresh();
    // Another request is already writing this brief: wait a moment and pick it up.
    if (res.failure.code === "brief_in_progress" && retries > 0) {
      await new Promise((r) => setTimeout(r, 3000));
      return write(retries - 1);
    }
    setFailure(res.failure);
  }

  return (
    <article className="brief">
      <div className="brief-head">
        <p className="eyebrow">{role.title} · {role.company}</p>
        <h1>No brief for this role yet</h1>
        <p className="pitch">Check the facts below first. If it&apos;s worth a weekend, we&apos;ll read the listing and write the brief. It usually takes 10 to 30 seconds, and it&apos;s saved for anyone who opens this page after you.</p>
      </div>
      <div className="layout">
        <div>
          <button className="btn" type="button" onClick={() => write()} disabled={busy}>{busy ? "Working…" : "Write my brief"}</button>
          {busy && <p className="note" aria-live="polite">{progressLabel(seconds, "Reading the listing…")}</p>}
          {failure && <p className="error" role="alert">{failure.message}</p>}
        </div>
        <aside className="side">
          <RoleCard role={role} />
          <a className="btn ghost" href={role.url} target="_blank" rel="noreferrer">View the role</a>
        </aside>
      </div>
    </article>
  );
}
