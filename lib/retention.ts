// Retention policy for Blob storage. Pure: given what's stored, the time, and which talent network
// roles are still open, it decides what may go. Nothing here deletes anything.
//
// | Data                     | Policy                                                     | Why                                              |
// | board/latest.json        | Keep. Overwritten daily.                                   | The live board.                                  |
// | briefs/<id>.json         | Keep.                                                      | Shared links people may have sent to a founder.  |
// | jobbriefs/<job>.json     | Remove 30 days after the role is no longer open.           | Reused by everyone while the role is live.       |
// | spend/<day>/<uuid>       | Remove days older than 2 days ago.                         | Only today's markers count toward the budget.    |
// | events/<name>/[<day>/<source>/]<uuid> | Keep (counts on /why). Roll up later; see the runbook.     | Deleting them would change the public counts.    |
// | Redis keys               | Expire on their own: limits (1 h), budget (2 days), locks (90 s). | Nothing to clean.                        |

export type StoredBlob = { pathname: string; uploadedAt: Date; size: number };
export type Decision = { pathname: string; action: "keep" | "delete"; reason: string };

export const CLOSED_ROLE_GRACE_DAYS = 30;
export const SPEND_KEEP_DAYS = 2;
const DAY = 24 * 60 * 60 * 1000;

// roleOpen(jobId): true if the role is still open, false if it's gone or closed, null if unknown
// (the talent network didn't answer). Unknown always keeps.
export function plan(blobs: StoredBlob[], now: Date, roleOpen: (jobId: string) => boolean | null): Decision[] {
  const today = now.toISOString().slice(0, 10);
  const spendCutoff = new Date(now.getTime() - SPEND_KEEP_DAYS * DAY).toISOString().slice(0, 10);
  return blobs.map((b): Decision => {
    const keep = (reason: string): Decision => ({ pathname: b.pathname, action: "keep", reason });
    const del = (reason: string): Decision => ({ pathname: b.pathname, action: "delete", reason });
    const [top, second] = b.pathname.split("/");
    if (top === "board") return keep("live board");
    if (top === "briefs") return keep("shared brief link");
    if (top === "events") return keep("counts on /why");
    if (top === "spend") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(second ?? "")) return keep("unrecognized spend path");
      if (second === today) return keep("today's budget");
      return second < spendCutoff ? del(`spend marker from ${second}, older than ${SPEND_KEEP_DAYS} days`) : keep("recent spend marker");
    }
    if (top === "jobbriefs") {
      const jobId = (second ?? "").replace(/\.json$/, "");
      const open = roleOpen(jobId);
      if (open === null) return keep("role status unknown");
      if (open) return keep("role still open");
      const ageDays = (now.getTime() - b.uploadedAt.getTime()) / DAY;
      return ageDays > CLOSED_ROLE_GRACE_DAYS ? del(`role closed, brief ${Math.floor(ageDays)} days old`) : keep(`role closed, within ${CLOSED_ROLE_GRACE_DAYS}-day grace`);
    }
    return keep("unrecognized path, left alone");
  });
}
