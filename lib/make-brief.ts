import Anthropic from "@anthropic-ai/sdk";
import { generateBrief, type GeneratedBrief } from "./brief";
import { fetchJobPost } from "./fetch-post";
import { recordEvent, saveBrief } from "./store";

type Result = { brief: GeneratedBrief; id: string | null } | { error: string; status: number };

const fail = (error: string, status: number) => ({ error, status });

// Shared by the paste box and the MCP server. The caller applies the rate limit.
export async function makeBrief(raw: unknown): Promise<Result> {
  if (!process.env.ANTHROPIC_API_KEY) return fail("Live briefs are switched off right now. Pick a role from the list instead.", 503);

  const input = typeof raw === "string" ? raw.trim() : "";
  if (input.length < 12) return fail("Paste a job link or the full job description.", 400);
  if (input.length > 20000) return fail("That's too long. Paste just the job description.", 400);

  let post = input;
  if (/^https?:\/\/\S+$/i.test(input)) {
    const fetched = await fetchJobPost(input).catch(() => null);
    if (!fetched) return fail("That page wouldn't load for us. Paste the job description instead.", 422);
    post = fetched;
  } else if (input.length < 200) {
    return fail("That's too short to be a full job description. Paste the whole post.", 400);
  }

  try {
    const brief = await generateBrief(post);
    if (!brief) return fail("That doesn't look like a job post. Paste the full description.", 422);
    const id = await saveBrief(brief).catch(() => null);
    await recordEvent("brief_created").catch(() => {});
    return { brief, id };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return fail("It's busy right now. Try again in a minute.", 503);
    if (err instanceof Anthropic.APIError) return fail("Brief generation failed. Try again in a minute.", 502);
    throw err;
  }
}
