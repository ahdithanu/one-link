// Where a visitor came from, as a coarse bucket. Worked out once, on the first page view of a
// browser session, and sent with every funnel event after that, so /stats can show a funnel per
// channel. Only the bucket name is kept: never the full referrer, URL or anything about the person.
//
// utm_source wins over the referrer, because apps like LinkedIn and Instagram often send none.
export const SOURCES = ["linkedin", "x", "instagram", "medium", "threads", "reddit", "hn", "github", "google", "bing", "email", "direct", "other", "agent"] as const;
export type Source = (typeof SOURCES)[number];

// Browsers marked internal (the owner, after logging into /stats) send this, and nothing is recorded.
export const INTERNAL = "internal";

const HOSTS: [RegExp, Source][] = [
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "linkedin"],
  [/(^|\.)(x|twitter)\.com$|^t\.co$/, "x"],
  [/(^|\.)instagram\.com$|^l\.instagram\.com$/, "instagram"],
  [/(^|\.)medium\.com$/, "medium"],
  [/(^|\.)threads\.(net|com)$/, "threads"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/^news\.ycombinator\.com$/, "hn"],
  [/(^|\.)github\.com$/, "github"],
  [/(^|\.)google\.[a-z.]+$/, "google"],
  [/(^|\.)bing\.com$/, "bing"],
];

const ALIASES: Record<string, Source> = { twitter: "x", ig: "instagram", li: "linkedin", newsletter: "email", hackernews: "hn" };

export function isSource(s: unknown): s is Source {
  return typeof s === "string" && (SOURCES as readonly string[]).includes(s);
}

export function sourceFrom(referrer: string, search: string, ownHost: string): Source {
  const utm = new URLSearchParams(search).get("utm_source")?.trim().toLowerCase();
  if (utm) return isSource(utm) && utm !== "agent" ? utm : (ALIASES[utm] ?? "other");
  if (!referrer) return "direct";
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === ownHost) return "direct";
  // Check webmail before the broader google rule.
  if (/^(mail\.google|outlook\.live|mail\.yahoo)\.com$/.test(host)) return "email";
  return HOSTS.find(([re]) => re.test(host))?.[1] ?? "other";
}
