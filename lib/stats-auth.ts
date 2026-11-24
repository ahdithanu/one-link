// The private /stats page. It exists only when STATS_KEY is set (16+ characters) in Vercel.
// Logging in sets an httpOnly cookie holding an HMAC of the key, never the key itself, so
// rotating STATS_KEY logs everyone out.
import { createHmac, timingSafeEqual } from "node:crypto";

export const STATS_COOKIE = "one_link_stats";
export const MIN_KEY = 16;

export const statsKey = (env: Record<string, string | undefined> = process.env) => {
  const k = env.STATS_KEY;
  return k && k.length >= MIN_KEY ? k : null;
};

export const sessionValue = (key: string) => createHmac("sha256", key).update("one-link-stats-session").digest("base64url");

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const keyMatches = (given: unknown, key: string) => typeof given === "string" && same(sessionValue(given), sessionValue(key));
export const sessionValid = (cookie: string | undefined, key: string) => typeof cookie === "string" && same(cookie, sessionValue(key));
