export type Send = { url: string; title: string; company: string };

const KEY = "one-link-sends";

export function readSends(): Send[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSend(send: Send) {
  try {
    localStorage.setItem(KEY, JSON.stringify([send, ...readSends()].slice(0, 20)));
  } catch {}
}
