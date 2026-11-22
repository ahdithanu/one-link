# One Link: production readiness audit

Audited at commit `89e893a` (the code deployed to production on 2026-11-19). The fixes below are on branch `fde-hardening`. Each finding is tagged as one of:

- **Spec violation:** breaks a MUST in the MCP spec or the JSON-RPC 2.0 spec.
- **Security:** a real exposure.
- **Reliability:** wrong behavior under failure or load.
- **Improvement:** optional.

Not using an MCP SDK is not treated as a defect. The server is about 200 lines with no protocol dependency, which keeps it auditable.

## How it was built (before)

| Area | What the code did |
| --- | --- |
| Transport | Stateless Streamable HTTP. One JSON-RPC message per POST, answered with one `application/json` body. No sessions, no SSE stream. `GET` answered 405. |
| Versions | `initialize` echoed 2025-11-25, 2025-06-18, 2025-03-26 or 2024-11-05, else offered 2025-11-25. |
| Capabilities | `tools` only (`listChanged: false`). Also answered `resources/list` and `prompts/list` with empty lists. |
| Tools | `get_build_brief` (read-only), `list_briefs` (read-only), `brief_from_job_post` (calls Claude, fetches URLs). JSON Schema `inputSchema` on each, plus `annotations`. |
| Validation | Only `get_build_brief` checked its argument. `list_briefs` silently ignored an invalid `function` or `limit`. |
| Errors | Unknown method -32601, unknown tool -32602. Exceptions became a generic tool error, so no internal text leaked. |
| Auth | None, on purpose: a public, read-mostly server. The only cost-bearing tool is rate-limited. |
| Rate limit | 5 model briefs an hour per `x-forwarded-for` IP, held in a `Map` in each instance's memory. |
| Persistence | Vercel Blob, private access. Generated briefs are stored under 72-bit random ids. The daily board is one JSON file. Usage counts are one empty blob per event. |
| External calls | The Anthropic API (`claude-opus-5-5`, structured output via zod). The public speedrun jobs API (daily cron). Arbitrary user-supplied job URLs. |
| Tests | None. `scripts/check-briefs.mjs` validated the bundled briefs once, when they were generated. |
| CI | None. Deploys are manual with `vercel deploy --prod`. |

## Findings, in priority order

| # | Severity | Type | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | High | Security | **SSRF through DNS rebinding.** `fetch-post.ts` resolved the hostname and checked the IPs, then `fetch()` resolved it again. A hostname whose DNS answer flips from public to private between the two lookups reached internal addresses. | Fixed. The connection uses a custom `lookup`, so the address that is checked is the one that is connected to (`safeLookup`). |
| 2 | Medium | Security | **Incomplete private-range list.** The list missed NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), hex IPv4-mapped IPv6 (`::ffff:7f00:1`), `198.18.0.0/15`, `192.0.0.0/24`, IPv6 site-local, and the documentation ranges. | Fixed. Uses `net.BlockList` with the full IANA special-purpose list, with 28 address tests. |
| 3 | Medium | Security | **Unbounded response read.** `res.text()` buffered the whole page before the 1.5 MB cap was applied. | Fixed. The body is streamed and the socket destroyed at the cap. |
| 4 | Medium | Security | **Unlimited blob writes.** Every `get_build_brief` call wrote a usage-event blob with no limit, so anyone could inflate the public usage counts on `/why` and the storage bill. | Fixed. Limited to 60 events an hour per caller per instance. |
| 5 | Medium | Spec violation | **`MCP-Protocol-Version` header ignored.** Spec 2025-06-18+: a request with an unsupported version header MUST get 400. | Fixed. |
| 6 | Medium | Spec violation | **No DNS-rebinding defense.** The spec says servers MUST validate Origin to prevent DNS rebinding. Confirmed by the official conformance suite (`dns-rebinding-protection` failed). | Fixed for Host: requests for a hostname the deployment doesn't serve get 403. Origin is deliberately not restricted (see Remaining deviations). |
| 7 | Medium | Reliability | **Model call could outlive the function.** The route's `maxDuration` is 60 s, but the SDK default is a 10 minute timeout with 2 retries, so the platform could kill the request mid-call. | Fixed. 45 s timeout, 1 retry. |
| 8 | Medium | Security | **7 dependency advisories (6 high).** Nested `zod` memory exhaustion, `postcss` source-map file read (build time), `sharp`/libvips, and the `@vercel/oidc` chain. | Fixed. Patch upgrades plus npm `overrides`. `npm audit` reports 0. |
| 9 | Medium | Reliability | **Unpinned SDK.** `"@anthropic-ai/sdk": "latest"` meant any deploy could pick up a new major version. | Fixed. `^1.3.0`, the version that was installed and tested. |
| 10 | Low | Spec violation | Malformed JSON got `-32600` instead of the JSON-RPC parse error `-32700`. | Fixed. |
| 11 | Low | Spec violation | `null` and object request ids were accepted (MCP: ids MUST be a string or number, never null). | Fixed. -32600 with HTTP 400. |
| 12 | Low | Spec violation | A JSON-RPC *response* from the client was rejected with 400. The spec says it gets 202. | Fixed. |
| 13 | Low | Improvement | Invalid tool arguments were coerced or ignored. The spec recommends returning them as tool errors (`isError`) so the model can correct itself. | Fixed. zod schemas mirror each `inputSchema`, with 13 invalid-argument tests in `test/tools.test.ts`. |
| 14 | Low | Security | The rate limiter's `Map` grew with every new IP and was never cleared. | Fixed. Bounded at 10k keys, oldest evicted first. |
| 15 | Low | Security | No global cap: many IPs could each use 5 model calls. | Fixed. 60 model calls an hour across all callers, counted in Upstash Redis, with a per-instance fallback if Redis is down (see the README's known limitations). |
| 16 | Low | Security | Invalid `brief_from_job_post` calls used up the caller's hourly allowance. | Fixed. Arguments are validated before the limit is checked. |
| 17 | Low | Security | No app-level request size limit (only the platform's 4.5 MB). | Fixed. 64 KB cap, read incrementally, 413 plus `connection: close`. |
| 18 | Low | Reliability | Every tool call did a Blob read with caching off (`useCache: false`). Measured production `list_briefs` median was 282 ms against 129 ms for `initialize`, which needs no data. | Fixed for MCP. 60 s in-memory board cache per instance. Pages still read fresh. After deploy, production `list_briefs` fell from a 282 ms to a 95 ms median, the same as `initialize`. |
| 19 | Low | Security | The cron secret was compared with `!==`, which is not constant-time. | Fixed. `timingSafeEqual` on SHA-256 digests. |
| 20 | Info | Improvement | No logs, so failures and model spend were invisible. | Fixed. One JSON line per MCP request (see README). |

### Checked, no issue found

- **Error leakage:** tool exceptions become a generic message, and a test asserts the exception text never reaches the client. `/api/cron/refresh` returns `err.message`, but only to a caller holding `CRON_SECRET`.
- **API key handling:** read from the environment only. Never logged. `.env*` is gitignored. Git history was scanned before the repo went public, and no secrets were found.
- **Storage permissions:** every blob is `access: "private"`. Brief ids are 9 random bytes (72 bits), and `loadBrief` checks the id format before reading.
- **Prompt injection:** the system prompt treats the job post as untrusted, and the post is wrapped in `<job_post>` tags. The impact is limited: the output is a brief returned to the same caller, and no tools run on the model's output. `evidence` is kept only if it appears word for word in the post.
- **Concurrency:** the handlers keep no shared mutable state other than the limiters and the board cache, which are synchronous Map and variable updates. Node's single thread makes those safe within an instance.

### Remaining deviations from the MCP spec (deliberate)

- **Origin is not restricted.** The spec says to validate Origin to stop DNS rebinding against *local* servers. This server is public, needs no credentials, and allows CORS from any site, so a rebinding attacker gets nothing they couldn't get by calling it directly. The Host allowlist gives the protection that matters, and the conformance check passes.
- **No JSON-RPC batching under 2025-03-26.** That version required servers to accept batches, and later versions removed them. Batches get a clear -32600. No current client sends them.
- **Text content is markdown, not serialized JSON.** Every tool declares an `outputSchema` and returns matching `structuredContent` (checked by tests). For older clients, the spec suggests (SHOULD) also putting the JSON in a text block. The text block is readable markdown instead, because agents show it to people.
