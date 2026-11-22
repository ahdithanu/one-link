# Case study: hardening One Link's MCP server

## The business problem

AI made job applications free to send, so founders at early-stage startups now get piles of polished applications that say little. A small working project still costs real effort and shows how someone thinks. But candidates don't know what to build for a given role, or whether the role is still worth a weekend. On the speedrun talent network's public board in mid-November 2026 (205 speedrun startup roles), 75% posted no pay and 43% were over 90 days old.

One Link answers both questions. For any job it writes a brief: the one thing to build, a Saturday-to-Sunday plan, what makes it good, how it falls flat, and the first line of the note. It shows the role's age and pay first. It works as a website, and as an MCP server, so an agent using the speedrun talent network's own MCP server can pass a job id straight across.

The MCP server worked, but it had never been tested, measured or audited. This project moves it toward production readiness without rebuilding it. It isn't production software yet: what's still missing is listed under [What should improve next](#what-should-improve-next) and in the README's known limitations.

## Technical architecture

- **Runtime:** Next.js 15 route handlers on Vercel's Node runtime. No server state except per-instance caches.
- **Transport:** stateless Streamable HTTP. Each POST carries one JSON-RPC message and gets one JSON response. No sessions and no SSE. Every tool finishes in one response, and stateless requests scale horizontally on serverless with no session affinity.
- **Layers:**
  - `app/mcp/route.ts`: HTTP only (body cap, IP, CORS).
  - `lib/mcp-http.ts`: JSON-RPC and MCP protocol rules, Host check, logging. A pure function of the body, headers and context, so it can be tested without a server.
  - `lib/mcp.ts`: tool definitions, zod argument validation, tool logic.
  - `lib/make-brief.ts`: shared generation path, with its dependencies injected so every failure can be tested without a network.
- **Data:** a daily cron writes the board (roles plus briefs) to private Vercel Blob. The app falls back to a bundled snapshot. Generated briefs are stored under 72-bit random ids. Pasted posts are never stored.
- **Model:** `claude-opus-5-5` with structured output against a zod schema. 45 s timeout and 1 retry, inside the 60 s function limit.

A diagram is in the [README](../README.md#architecture).

## What the audit found

The full list, with severities, is in [docs/audit.md](audit.md). The ones that mattered:

1. **SSRF via DNS rebinding (high).** The URL fetcher resolved the hostname, checked the IPs, then let `fetch()` resolve it again. An attacker-controlled DNS name could answer with a public IP for the check and a private one for the connection. The fix moves the check into the socket's own `lookup` callback, so the address checked is the address connected to. It also replaces a hand-rolled range check that missed NAT64, 6to4 and hex IPv4-mapped forms with `net.BlockList` over the IANA special-purpose list.
2. **Protocol MUSTs.** The server ignored `MCP-Protocol-Version` (it must 400 on an unsupported value) and had no DNS-rebinding defense. The official conformance suite confirmed the second one. There were smaller JSON-RPC errors: -32600 where -32700 belonged, null ids accepted, and client responses rejected.
3. **Cost and abuse paths.** A free read tool wrote an unbounded number of blobs, which also let anyone inflate the public usage counter. The rate limiter's memory grew without bound. Malformed requests used up a caller's model allowance.
4. **Reliability.** The SDK's default 10-minute timeout could outlive the 60 s function. `@anthropic-ai/sdk` was pinned to `latest`. 7 dependency advisories.
5. **Performance.** Benchmarking production showed `list_briefs` at 282 ms median against 129 ms for `initialize`. The difference was an uncached Blob read on every tool call, for data that changes once a day.

## Engineering tradeoffs

- **No MCP SDK.** The hand-written server is about 200 lines and has no protocol dependency. The cost is owning spec compliance, so conformance is now tested three ways: unit tests, an HTTP smoke test, and the official conformance suite.
- **Origin left open, Host restricted.** The spec's rebinding guidance targets local servers. This server is public and credential-free with CORS `*`, so restricting Origin would break browser clients and protect nothing. The Host allowlist stops the rebinding pattern itself and passes the conformance check. It's documented as a deliberate deviation rather than hidden.
- **In-memory rate limits instead of Redis.** Adding a store for a portfolio-scale app means another dependency and another bill. Per-instance limits plus the Anthropic workspace spend cap bound the worst case. This is the first thing I'd change with real traffic (see below).
- **60 s board cache for MCP only.** Pages still read fresh, because the daily cron revalidates pages right after writing the board. A cached page render could otherwise freeze yesterday's board for an hour. Agents can tolerate a board that is up to a minute stale.
- **Tool errors, not protocol errors, for bad arguments.** A model can read `isError` content and retry with fixed arguments. A JSON-RPC error usually surfaces as a client failure.
- **Two eval layers.** The deterministic checks run in CI on every push for free. The model eval costs money and is noisy, so it runs on demand. Its judge is a model, so its numbers are reported as estimates.

## Failure modes, and what happens now

| Failure | Behavior |
| --- | --- |
| Anthropic rate limit | Tool error "busy, try again", HTTP 503 on the web route, `model_rate_limited` in logs |
| Anthropic outage or timeout (>45 s) | Tool error, `model_error`. The function returns before Vercel kills it. |
| No API key configured | Read tools keep working, and `brief_from_job_post` says live briefs are off (`model_unavailable`) |
| Blob down | The board falls back to the bundled snapshot. A generated brief is still returned, without a share link. |
| Job URL blocked, slow, huge or not HTML | Tool error asking for the pasted description (`fetch_failed`), with an 8 s timeout and 1.5 MB streamed cap |
| Text that isn't a job post | Tool error (`not_a_job_post`). The model is told to return empty fields, and those are rejected. |
| Prompt injection in a post | Treated as data. Output must match the schema, and the eval includes an injection case. |
| Unexpected exception | Generic tool error with no internal text (tested), `internal` in logs |
| Abuse | 5 model calls an hour per caller and 60 across everyone (shared in Redis), a reserved daily brief budget, 60 usage events an hour per caller, 64 KB bodies |
| Redis down or slow | Limits fall back to per-instance windows after 1.5 s, and the daily cap to blob markers. Weaker, never off. |
| Two people ask for the same new brief at once | The second request joins the first and gets the same brief, with no second model call (within an instance) |

## Evaluation methodology and results

- **Tests (138, all passing).**
  - Protocol: 30. Lifecycle, version negotiation, every error code, size and header rules.
  - Tool contracts: 30. Every id form, filters, limits, and invalid arguments.
  - `makeBrief`: 16. Every failure mapping, with an injected model and fetcher.
  - Security: 62. Address classification, URL rules, socket-level lookup refusal, limiter behavior, body caps, log hygiene, Host allowlist.
- **Deterministic tool eval: 2,426 / 2,426 checks pass** over all 195 open roles in the bundled board, across 21 check types. The 100% isn't surprising: the bundled briefs were filtered by the same rules when they were generated. The eval's value is that it now runs on every push, so a regression in the handlers or the data shows up immediately.
- **Conformance:** every official conformance scenario that applies to a tools-only server passes. The 24 other scenarios exercise prompts, resources, logging, completion, or the suite's own fixture tools, and the server correctly rejects them. MCP Inspector CLI 2.16.0 lists and calls tools correctly. Claude Code reports the production server as connected.
- **Model eval: built, not yet run.** The dataset is frozen: 11 real public posts across 9 functions, plus 4 adversarial cases (non-job text, prompt injection, a thin post, a Spanish post). Each output gets 11 deterministic checks, a check for numbers that don't appear in the post, and a judge that lists unsupported claims and scores relevance. The production key is a sensitive Vercel variable, so it can't be pulled locally. I haven't published any quality numbers for this layer yet; run `npm run eval:model` to get them.

## Measured performance

From `npm run bench`, sequential requests, 3 warm-up requests discarded:

| Operation | Local median / p95 | Production before | Production after |
| --- | --- | --- | --- |
| initialize | 2.0 / 2.5 ms | 128.5 / 167.0 ms | 97.0 / 143.3 ms |
| tools/list | 2.0 / 2.4 ms | 141.8 / 287.4 ms | 96.0 / 106.8 ms |
| list_briefs | 2.1 / 3.0 ms | 282.2 / 418.7 ms | 95.1 / 111.7 ms |

Local means a laptop over loopback with the bundled board, which shows handler cost only. Production means the same laptop calling the deployed build, including the network: "before" is the pre-change build on 2026-11-19, and "after" is this branch on 2026-11-20. Local and production are different conditions, so those columns aren't directly comparable. The useful comparison is within each production column. Before, `list_briefs` cost about 150 ms more than `initialize`. After, the two are equal, which confirms the board cache removed the per-call Blob read.

## Production considerations

- **Deploy:** manual `vercel deploy --prod` after CI passes on the branch. Deployed to production on 2026-11-20 at `f2dd299`, after CI passed on the PR. The post-deploy smoke test passed 13/13.
- **Watch:** filter Vercel logs on `"event":"mcp_request"`.
  - Error rate by `error_category`.
  - p95 `duration_ms` per tool.
  - Daily sum of `usage.output_tokens`, as the cost signal.
- **Custom domain:** add it to `MCP_ALLOWED_HOSTS`, or the MCP endpoint will answer 403 on it.
- **Spend:** keep a monthly spend cap on the Anthropic workspace. It's the only hard ceiling on cost.

## What should improve next

1. **Real alerting.** A scheduled check now runs the smoke test against production every 15 minutes and emails on failure. Next is an alert on error rate and p95 latency from the logs, routed to a phone.
2. **Run the model eval** with 3 runs per case, so variance is visible. Add a small human-labeled set to calibrate the judge.
3. **A cross-instance lock for brief writes.** Duplicate writes are joined within an instance. Redis is now in place, so a `SET NX` lock per job id would make that hold across instances.
4. **Measure the outcome that matters:** how many briefs turn into a shipped link, not how many briefs are generated.
