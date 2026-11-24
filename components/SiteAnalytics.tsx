"use client";
import { Analytics } from "@vercel/analytics/next";

// Vercel Web Analytics: cookieless page views, referrers, countries and devices.
// The private /stats page is left out.
export function SiteAnalytics() {
  return <Analytics beforeSend={(e) => (new URL(e.url).pathname.startsWith("/stats") ? null : e)} />;
}
