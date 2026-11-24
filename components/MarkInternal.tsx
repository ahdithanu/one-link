"use client";
import { useEffect, useState } from "react";
import { markInternal } from "@/lib/track";

// Shown only to someone logged into /stats: from now on this browser's visits and events aren't
// counted, here or in Vercel Web Analytics.
export function MarkInternal() {
  const [done, setDone] = useState(false);
  useEffect(() => {
    markInternal();
    setDone(true);
  }, []);
  return done ? <p className="note">This browser is now excluded from all counts, here and in Vercel Analytics.</p> : null;
}
