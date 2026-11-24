"use client";

import { useEffect, useRef, useState } from "react";
import { currentSource } from "@/lib/track";

// Shared by the paste box and the job page: one request at a time, a visible elapsed timer, a
// client-side timeout, and a message for each way it can fail.

export const TIMEOUT_MS = 75_000;

export type Failure = { message: string; code: string };

const MESSAGES: Record<string, string> = {
  timeout: "This is taking longer than usual. Try again in a minute.",
  network: "We couldn't reach One Link. Check your connection and try again.",
};

export function useBriefRequest() {
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setSeconds(0);
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // Returns the JSON body on success, or a Failure. A second call while one is running is ignored,
  // so double clicks and double submits can't start two generations.
  async function send<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; failure: Failure } | null> {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-one-link-source": currentSource() }, body: JSON.stringify(body), signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, data: data as T };
      return { ok: false, failure: { message: data.error ?? "Something went wrong. Try again.", code: data.code ?? String(res.status) } };
    } catch (err) {
      const code = (err as Error).name === "AbortError" ? "timeout" : "network";
      return { ok: false, failure: { message: MESSAGES[code], code } };
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { busy, seconds, send };
}

// What to show while a brief is being written. Honest about time, not about invented steps.
export function progressLabel(seconds: number, reading: string) {
  if (seconds < 3) return reading;
  if (seconds < 30) return `Writing your brief… ${seconds}s (usually 10 to 30s)`;
  return `Still writing… ${seconds}s. Some posts take longer.`;
}
