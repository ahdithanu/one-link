const WINDOW_MS = 60 * 60 * 1000;
export const PER_IP = 5;
const hits = new Map<string, number[]>();

// Per-instance limit, shared by the site and the MCP server. The Anthropic workspace spend cap is the hard ceiling.
export function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= PER_IP) return true;
  hits.set(ip, [...recent, now]);
  return false;
}

export const clientIp = (headers: Headers) => headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
