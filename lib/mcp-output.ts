import { z } from "zod";

// The shape of each tool's structuredContent. The JSON Schema in tools/list (outputSchema) is
// generated from these, and the tests check real tool results against them, so the advertised
// schema and the actual output can't drift apart. Objects allow extra fields so adding a field
// later doesn't break clients that validate.

const Brief = z.looseObject({
  need: z.string(),
  evidence: z.string(),
  build: z.looseObject({ title: z.string(), pitch: z.string() }),
  plan: z.array(z.looseObject({ when: z.string(), do: z.string() })),
  good: z.array(z.string()),
  avoid: z.string(),
  opener: z.string(),
});

const Pay = z.union([
  z.looseObject({ kind: z.literal("posted"), min: z.number(), max: z.number() }),
  z.looseObject({ kind: z.literal("estimate"), function: z.string(), p25: z.number(), median: z.number(), p75: z.number() }),
  z.looseObject({ kind: z.literal("unposted") }),
]);

const Role = z.looseObject({
  id: z.string(),
  short: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string().nullable(),
  workplace: z.string().nullable(),
  url: z.string(),
  posted: z.string(),
  ageDays: z.number(),
  pay: Pay,
  conflict: z.string().nullable(),
  warnings: z.array(z.string()),
});

const RoleBrief = z.looseObject({ role: Role, brief: Brief, url: z.string() });

export const OUTPUT = {
  get_build_brief: RoleBrief,
  brief_for_job: RoleBrief,
  list_briefs: z.looseObject({
    total: z.number().int(),
    roles: z.array(
      z.looseObject({
        job_id: z.string(),
        title: z.string(),
        company: z.string(),
        function: z.string(),
        posted_days_ago: z.number(),
        pay_posted: z.boolean(),
        build: z.string(),
        url: z.string(),
      }),
    ),
  }),
  search_roles: z.looseObject({
    total: z.number().int(),
    page: z.number().int(),
    has_more: z.boolean(),
    roles: z.array(
      z.looseObject({
        job_id: z.string(),
        title: z.string(),
        company: z.string(),
        location: z.string().nullable(),
        posted_days_ago: z.number(),
        pay_posted: z.boolean(),
        has_brief: z.boolean(),
        url: z.string(),
      }),
    ),
  }),
  brief_from_job_post: z.looseObject({
    brief: Brief.extend({ company: z.string(), title: z.string() }),
    url: z.string().nullable(),
  }),
};

export const outputSchema = (name: keyof typeof OUTPUT) => z.toJSONSchema(OUTPUT[name]) as Record<string, unknown>;
