// Storage cleanup. Dry run by default: lists what the retention policy (lib/retention.ts) would
// remove and why, and deletes nothing. Read-only against Blob and the talent network API.
//
//   vercel env run -e production -- npx tsx scripts/cleanup.mts
//
// Deleting needs both --apply and CONFIRM_DELETE=yes, and should only ever be run after the owner
// has reviewed a dry run.
import { del, list } from "@vercel/blob";
import { getNetworkJob } from "../lib/network";
import { plan, type StoredBlob } from "../lib/retention";

const APPLY = process.argv.includes("--apply") && process.env.CONFIRM_DELETE === "yes";
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("No BLOB_READ_WRITE_TOKEN. Run it through `vercel env run -e production --`.");
  process.exit(2);
}

const blobs: (StoredBlob & { url: string })[] = [];
let cursor: string | undefined;
do {
  const page = await list({ limit: 1000, cursor });
  blobs.push(...page.blobs.map((b) => ({ pathname: b.pathname, uploadedAt: new Date(b.uploadedAt), size: b.size, url: b.url })));
  cursor = page.cursor;
} while (cursor);

// Look up each stored network brief's role, paced to respect the API.
const status = new Map<string, boolean | null>();
for (const b of blobs.filter((x) => x.pathname.startsWith("jobbriefs/"))) {
  const id = b.pathname.slice("jobbriefs/".length).replace(/\.json$/, "");
  const job = await getNetworkJob(id);
  status.set(id, job ? job.status === "open" : null);
  await new Promise((r) => setTimeout(r, 1000));
}

const decisions = plan(blobs, new Date(), (id) => status.get(id) ?? null);
const doomed = decisions.filter((d) => d.action === "delete");
const kept = decisions.length - doomed.length;
const reasons = new Map<string, number>();
for (const d of decisions) reasons.set(`${d.action}: ${d.reason.replace(/\d{4}-\d{2}-\d{2}|\d+ days old/g, "…")}`, (reasons.get(`${d.action}: ${d.reason.replace(/\d{4}-\d{2}-\d{2}|\d+ days old/g, "…")}`) ?? 0) + 1);
console.log(`${blobs.length} blobs: ${kept} kept, ${doomed.length} would be removed.`);
for (const [r, n] of [...reasons].sort()) console.log(`  ${String(n).padStart(5)}  ${r}`);
if (doomed.length) console.log(`\nWould remove:\n${doomed.map((d) => `  ${d.pathname}  (${d.reason})`).join("\n")}`);

if (process.argv.includes("--apply") && !APPLY) console.log("\n--apply also needs CONFIRM_DELETE=yes. Nothing was deleted.");
if (APPLY && doomed.length) {
  const urls = blobs.filter((b) => doomed.some((d) => d.pathname === b.pathname)).map((b) => b.url);
  await del(urls);
  console.log(`\nDeleted ${urls.length} blobs.`);
} else if (!APPLY) console.log("\nDry run: nothing was deleted.");
