import { INTERNAL, sourceFrom } from "./source";
import type { EventName } from "./store";

const SOURCE_KEY = "one-link-source";
const INTERNAL_KEY = "one-link-internal";

// Set by /stats once the owner logs in, so their own browsing stops counting.
export function isInternal() {
  try {
    return localStorage.getItem(INTERNAL_KEY) === "1";
  } catch {
    return false;
  }
}

export function markInternal() {
  try {
    localStorage.setItem(INTERNAL_KEY, "1");
  } catch {}
}

// The session's first-touch source bucket, worked out on the first call and kept for the session.
export function currentSource(): string {
  if (isInternal()) return INTERNAL;
  const fresh = () => sourceFrom(document.referrer, location.search, location.hostname);
  try {
    let s = sessionStorage.getItem(SOURCE_KEY);
    if (!s) {
      s = fresh();
      sessionStorage.setItem(SOURCE_KEY, s);
    }
    return s;
  } catch {
    return fresh();
  }
}

export function track(name: EventName) {
  if (isInternal()) return;
  fetch("/api/event", { method: "POST", keepalive: true, body: JSON.stringify({ name, source: currentSource() }) }).catch(() => {});
}
