"use client";
import { Analytics } from "@vercel/analytics/next";
import { isInternal } from "@/lib/track";

// Vercel Web Analytics: cookieless page views, referrers, countries and devices.
// The private /stats page and the owner's browser (marked on /stats) are left out.
export function SiteAnalytics() {
  return <Analytics beforeSend={(e) => (isInternal() || new URL(e.url).pathname.startsWith("/stats") ? null : e)} />;
}
