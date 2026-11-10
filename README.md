# One Link

AI made applying for jobs free, so a resume now says less than ever. A working thing still costs real effort, and it shows a founder how someone thinks.

One Link turns a job post into a weekend proof-of-work brief:

- the one thing to build that would get the hiring manager to reply
- a three-step weekend plan
- what makes it good, and how it falls flat
- the first line of the note to send with it

Each brief puts the role's age and pay first, so nobody spends a weekend on a listing that has gone quiet.

**Live:** https://one-link-eta.vercel.app · **Why it exists:** https://one-link-eta.vercel.app/why · **Code:** https://github.com/ahdithanu/one-link

> An independent concept. Not affiliated with or endorsed by a16z or speedrun.

## What's in it

| Page | What it does |
| --- | --- |
| `/` | Paste any job link or description and get a brief, or pick an open role from the speedrun talent network |
| `/r/<id>` | The ready-made brief for one speedrun portfolio role, quoting its job post word for word |
| `/b/<id>` | A shareable brief made from a pasted job |
| `/why` | Why it was built, what the board data showed, and live anonymous usage counts |
| `/founders` | A mock of what a founder would see (sample entries) |
| `/mcp` | An MCP server, so AI agents can fetch briefs |

## For AI agents (MCP)

One Link is a public MCP server over Streamable HTTP. It needs no key and stores nothing about the caller.

```bash
claude mcp add --transport http one-link https://one-link-eta.vercel.app/mcp
```

| Tool | What it does |
| --- | --- |
| `get_build_brief` | Brief for a speedrun role, from a job UUID, its first 8 hex characters, or a job URL |
| `list_briefs` | Open roles that have a brief, filterable by text or function |
| `brief_from_job_post` | New brief for any job at any company, from its description or link (5 an hour per caller) |

It pairs with the speedrun talent network's own MCP server. Both use the same job ids, so an agent can find a role with `search_jobs` and pass the id straight to `get_build_brief`:

```bash
claude mcp add --transport http speedrun-talent https://mcp.speedrun-talent-network.com/mcp
```

## How it works

- **Ready-made briefs.** A daily Vercel cron (`/api/cron/refresh`, 13:00 UTC) reads the public speedrun talent network jobs API, writes briefs for up to 12 new roles, and saves the board to Vercel Blob. If Blob is unavailable, the app falls back to the bundled `data/roles.json` and `data/briefs.json`.
- **Briefs from a pasted job.** `lib/make-brief.ts` fetches the post if given a link, then asks Claude for a structured brief (validated with zod). The paste box and the MCP server share this code and the same per-IP limit (`lib/limit.ts`).
- **Privacy.** Only the generated brief is saved, never the pasted post. Usage counts are one empty file per event, with nothing about the person. Finished work a person adds stays in their own browser.

## Run it locally

Requires Node 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

The app runs at http://localhost:3210. Without any environment variables it still serves the bundled roles and briefs; set these to turn on the rest:

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Writing new briefs (paste box, `brief_from_job_post`, the daily refresh) |
| `BLOB_READ_WRITE_TOKEN` | Saving briefs, the refreshed board, and usage counts |
| `CRON_SECRET` | Protecting `/api/cron/refresh` |

To test the MCP server locally:

```bash
curl -s localhost:3210/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Stack

Next.js 15 (App Router) on Vercel, Vercel Blob, the Anthropic SDK, and zod. The MCP server is hand-written in `app/mcp/route.ts` and `lib/mcp.ts`, with no SDK dependency.

## What isn't real yet

- Finished work is saved in the person's browser. Nothing reaches a founder or speedrun.
- The founder queue uses made-up sample entries.
- No one at speedrun has seen or approved this.
