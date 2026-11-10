import type { GeneratedBrief } from "./brief";
import { findRole, getListings, type Brief, type Role } from "./data";
import { makeBrief } from "./make-brief";
import { recordEvent } from "./store";

export const SERVER = { name: "one-link", title: "One Link", version: "0.2.0" };

export const INSTRUCTIONS = `One Link turns a job into a weekend proof-of-work brief: the one thing to build that makes the hiring manager reply, a three-step plan, and the first line of the note to send with it.

It pairs with the a16z speedrun talent network MCP server. Job ids are shared, so pass a job id or url from its search_jobs or get_job straight to get_build_brief. Speedrun portfolio roles have a brief ready. For any other job, at any company, use brief_from_job_post.

Show the build title, the plan and the opener. Before the candidate commits a weekend, tell them the role's age and whether pay is posted.`;

const k = (n: number) => `$${Math.round(n / 1000)}k`;

export const TOOLS = [
  {
    name: "get_build_brief",
    title: "Get a build brief for a speedrun role",
    description:
      "Get the ready-made proof-of-work brief for a role on the a16z speedrun talent network: what to build this weekend, the plan, what makes it good, and the first line of the note. Takes a job id (UUID or its first 8 hex characters) or a speedrun-talent-network.com job url, as returned by the speedrun talent MCP server's search_jobs or get_job. Also returns the role's age and pay so the candidate can check it's worth a weekend.",
    inputSchema: {
      type: "object",
      properties: { job: { type: "string", minLength: 8, maxLength: 300, description: "Job UUID, 8-hex id prefix, or job url." } },
      required: ["job"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_briefs",
    title: "List speedrun roles with briefs",
    description:
      "List open a16z speedrun portfolio roles that have a brief ready, newest first, with what each brief says to build. Filter by free text over title, company and build, or by function.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", maxLength: 120, description: "Free text over title, company and the build title." },
        function: {
          type: "string",
          enum: ["engineering", "research", "product", "design", "sales", "marketing", "operations", "other"],
        },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "brief_from_job_post",
    title: "Write a brief for any job",
    description:
      "Write a new proof-of-work brief for any job at any company, from the full job description or a public job link. Takes 10 to 30 seconds. Limited to 5 an hour per caller. Returns a shareable brief url.",
    inputSchema: {
      type: "object",
      properties: { job_post: { type: "string", minLength: 12, maxLength: 20000, description: "The full job description, or a public url to it." } },
      required: ["job_post"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
] as const;

// The id is the last 8 hex characters in a slug url, or the start of a UUID.
export function parseJobRef(ref: string) {
  const s = ref.trim().toLowerCase();
  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  if (uuid) return uuid[0].slice(0, 8);
  const path = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const tail = path.match(/(?:^|[-/])([0-9a-f]{8})$/);
  return tail ? tail[1] : null;
}

function payLine(role: Role) {
  if (role.pay.kind === "posted") return `${k(role.pay.min)} to ${k(role.pay.max)}, as posted`;
  return `Not posted. Board-wide, ${role.pay.function} roles with posted pay run ${k(role.pay.p25)} to ${k(role.pay.p75)} in the middle half. That is not this role's pay.`;
}

function warnings(role: Role) {
  const out: string[] = [];
  if (role.open === false) out.push("This role is no longer listed on the talent network.");
  else if (role.ageDays > 90) out.push("This listing is over 90 days old. Check it's still open first.");
  if (role.conflict) out.push(role.conflict);
  return out;
}

function briefText(brief: Brief | GeneratedBrief, heading: string, url: string | null, role?: Role) {
  const lines = [`# ${brief.build.title}`, heading, "", brief.build.pitch, "", `What they need: ${brief.need}`];
  if (brief.evidence) lines.push(`From the post: "${brief.evidence}"`);
  lines.push("", "## The weekend", ...brief.plan.map((p) => `- ${p.when}: ${p.do}`));
  lines.push("", "## What makes it good", ...brief.good.map((g) => `- ${g}`));
  lines.push("", `How this falls flat: ${brief.avoid}`, "", `First line of the note: ${brief.opener}`);
  if (role) {
    lines.push("", "## Before you spend a weekend", `- Posted: ${role.ageDays} days ago`, `- Pay: ${payLine(role)}`);
    lines.push(`- Where: ${[role.location, role.workplace].filter(Boolean).join(", ") || "Not stated"}`);
    lines.push(...warnings(role).map((w) => `- Warning: ${w}`));
    lines.push(`- Apply: ${role.url}`);
  }
  if (url) lines.push("", `Shareable brief: ${url}`);
  return lines.join("\n");
}

type Content = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const text = (t: string, isError = false): Content => ({ content: [{ type: "text", text: t }], ...(isError && { isError }) });

export async function callTool(name: string, args: Record<string, unknown>, ctx: { origin: string; limited: () => boolean }): Promise<Content | null> {
  if (name === "get_build_brief") {
    const short = typeof args.job === "string" ? parseJobRef(args.job) : null;
    if (!short) return text("Pass a job UUID, its first 8 hex characters, or a speedrun-talent-network.com job url.", true);
    const found = await findRole(short);
    if (!found)
      return text(
        "No ready brief for that job. Only open a16z speedrun portfolio roles have one, and new roles get theirs within a day. For any other job, call brief_from_job_post with its description.",
        true,
      );
    const { role, brief } = found;
    const url = `${ctx.origin}/r/${role.short}`;
    await recordEvent("agent_brief").catch(() => {});
    return {
      ...text(briefText(brief, `${role.title} at ${role.company}`, url, role)),
      structuredContent: { role: { ...role, warnings: warnings(role) }, brief, url },
    };
  }

  if (name === "list_briefs") {
    const q = typeof args.q === "string" ? args.q.trim().toLowerCase() : "";
    const fn = typeof args.function === "string" ? args.function : "";
    const limit = Math.min(50, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : 20));
    const all = (await getListings()).filter(
      (r) => (!fn || r.function === fn) && (!q || `${r.title} ${r.company} ${r.buildTitle}`.toLowerCase().includes(q)),
    );
    const rows = all.slice(0, limit).map((r) => ({
      job_id: r.id,
      title: r.title,
      company: r.company,
      function: r.function,
      posted_days_ago: r.ageDays,
      pay_posted: r.pay.kind === "posted",
      build: r.buildTitle,
      url: `${ctx.origin}/r/${r.short}`,
    }));
    const body = rows.length
      ? rows.map((r) => `- ${r.title} at ${r.company} (${r.posted_days_ago}d old) -> build: ${r.build} [job_id ${r.job_id}]`).join("\n")
      : "No matching roles.";
    return { ...text(`${all.length} matching roles, showing ${rows.length}.\n${body}`), structuredContent: { total: all.length, roles: rows } };
  }

  if (name === "brief_from_job_post") {
    if (ctx.limited()) return text("Limit of 5 new briefs an hour reached. Try again later, or use get_build_brief for speedrun roles.", true);
    const result = await makeBrief(args.job_post);
    if ("error" in result) return text(result.error, true);
    const url = result.id ? `${ctx.origin}/b/${result.id}` : null;
    await recordEvent("agent_brief").catch(() => {});
    const { brief } = result;
    return { ...text(briefText(brief, `${brief.title} at ${brief.company}`, url)), structuredContent: { brief, url } };
  }

  return null;
}
