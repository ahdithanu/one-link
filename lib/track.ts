import type { EventName } from "./store";

export function track(name: EventName) {
  fetch("/api/event", { method: "POST", keepalive: true, body: JSON.stringify({ name }) }).catch(() => {});
}
