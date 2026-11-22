import Anthropic from "@anthropic-ai/sdk";
import { generateBrief, type GeneratedBrief } from "./brief";
import { FetchBlocked, fetchJobPost } from "./fetch-post";
import type { ErrorCategory, Usage } from "./log";
import { recordEvent, saveBrief } from "./store";

export type MakeBriefResult =
  | { brief: GeneratedBrief; id: string | null; usage?: Usage }
  | { error: string; status: number; category: ErrorCategory; usage?: Usage };

export type MakeBriefDeps = {
  hasKey: () => boolean;
  fetchPost: (url: string) => Promise<string | null>;
  generate: (post: string, onUsage: (u: Usage) => void) => Promise<GeneratedBrief | null>;
  save: (brief: GeneratedBrief) => Promise<string>;
  record: () => Promise<void>;
};

export const defaultDeps: MakeBriefDeps = {
  hasKey: () => Boolean(process.env.ANTHROPIC_API_KEY),
  fetchPost: fetchJobPost,
  generate: generateBrief,
  save: saveBrief,
  record: () => recordEvent("brief_created"),
};

export const MIN_POST = 200;
export const MAX_POST = 20000;

const fail = (error: string, status: number, category: ErrorCategory, usage?: Usage) => ({ error, status, category, ...(usage && { usage }) });

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

// The checks that need no network or model. Callers run these before the rate limit, so a
// malformed request never uses up someone's allowance.
export function checkInput(raw: unknown): { error: string; status: number; category: ErrorCategory } | null {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (input.length < 12) return fail("Paste a job link or the full job description.", 400, "invalid_arguments");
  if (input.length > MAX_POST) return fail("That's too long. Paste just the job description.", 400, "invalid_arguments");
  if (!isUrl(input) && input.length < MIN_POST) return fail("That's too short to be a full job description. Paste the whole post.", 400, "invalid_arguments");
  return null;
}

// Shared by the paste box and the MCP server. The caller applies the rate limit.
export async function makeBrief(raw: unknown, deps: MakeBriefDeps = defaultDeps): Promise<MakeBriefResult> {
  if (!deps.hasKey()) return fail("Live briefs are switched off right now. Pick a role from the list instead.", 503, "model_unavailable");
  const invalid = checkInput(raw);
  if (invalid) return invalid;

  const input = (raw as string).trim();
  let post = input;
  if (isUrl(input)) {
    const fetched = await deps.fetchPost(input).catch((err) => (err instanceof FetchBlocked ? "blocked" : null));
    if (fetched === "blocked") return fail("Only public https job pages can be fetched. Paste the job description instead.", 422, "fetch_failed");
    if (!fetched) return fail("That page wouldn't load for us. Paste the job description instead.", 422, "fetch_failed");
    post = fetched;
  }

  let usage: Usage | undefined;
  try {
    const brief = await deps.generate(post, (u) => (usage = u));
    if (!brief) return fail("That doesn't look like a job post. Paste the full description.", 422, "not_a_job_post", usage);
    const id = await deps.save(brief).catch(() => null);
    await deps.record().catch(() => {});
    return { brief, id, ...(usage && { usage }) };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return fail("It's busy right now. Try again in a minute.", 503, "model_rate_limited", usage);
    if (err instanceof Anthropic.APIError) return fail("Brief generation failed. Try again in a minute.", 502, "model_error", usage);
    throw err;
  }
}
