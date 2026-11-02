"use client";

import { useEffect, useState } from "react";
import { readSends, Send } from "@/lib/sends";

const SAMPLES = [
  { name: "Maya R.", role: "Founding Engineer, sample dev-tools startup", built: "A working CLI that reproduces and explains the startup's most common setup error", tags: ["Live demo", "Code public", "Built in 2 days"] },
  { name: "Jon K.", role: "Founding GTM, sample fintech startup", built: "A list of 40 target accounts, each with the public trigger that makes them worth a call", tags: ["Live sheet", "Sources linked", "Built in 2 days"] },
  { name: "Ana P.", role: "Product Designer, sample consumer app", built: "A clickable rework of the first five minutes in the app, tested with five people", tags: ["Prototype", "Test notes", "Built in 3 days"] },
];

export default function Founders() {
  const [mine, setMine] = useState<Send[]>([]);
  useEffect(() => setMine(readSends()), []);

  return (
    <main>
      <section className="queue-head">
        <h1>Read the work, not the resume.</h1>
        <p>Every person in this queue built something for your role before they reached out. You open a link, and you know in two minutes whether to reply.</p>
      </section>
      <div className="compare">
        <div className="card"><h3>Costs effort to fake</h3><p className="note">An AI tool can write a thousand applications. It can&apos;t show up with a thing that works and defend it on a call.</p></div>
        <div className="card"><h3>Shows the job itself</h3><p className="note">You see how someone picks a problem, cuts scope and finishes, which a resume can only claim.</p></div>
        <div className="card"><h3>Helps the talent team route</h3><p className="note">One link tells them who has already done real work for a role like yours.</p></div>
      </div>
      <p className="banner">Sample queue. These people and companies are made up to show the idea. Links you add yourself are saved in your browser only.</p>
      <ul className="queue">
        {mine.map((s) => (
          <li className="entry mine" key={s.url}>
            <div>
              <p className="eyebrow">Your link</p>
              <h3>{s.url.replace(/^https:\/\//, "").replace(/\/$/, "")}</h3>
              <p className="meta">{[s.title, s.company].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="act"><a className="btn" href={s.url} target="_blank" rel="noreferrer">Open link</a></div>
          </li>
        ))}
        {SAMPLES.map((s) => (
          <li className="entry" key={s.name}>
            <div>
              <h3>{s.name}</h3>
              <p className="meta">{s.role}</p>
              <p style={{ marginTop: 6 }}>{s.built}</p>
              <div className="tags">{s.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>
            </div>
            <div className="act"><span className="note">Sample entry</span></div>
          </li>
        ))}
      </ul>
    </main>
  );
}
