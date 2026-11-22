# MCP client compatibility and conformance

Checked on 2026-11-22. "Local" is the latest `main` plus the security-review branch, built with `next start`. "Production" is `https://one-link-eta.vercel.app/mcp`, which still runs the build deployed on 2026-11-22 (v0.5.0) until the next deploy.

## Verified

| Client or tool | Against | What was checked | Result |
| --- | --- | --- | --- |
| Official MCP conformance suite 0.1.16 | Local, and in CI on every PR | All 31 scenarios. CI fails if any scenario that applies to a tools-only server stops passing. | 8 pass, including server-initialize, ping, tools-list, resources-list, prompts-list and dns-rebinding-protection (2/2). The other 24 test features One Link doesn't offer (resources/read, prompts/get, the suite's own fixture tools, sampling, elicitation, logging), and it correctly rejects them. |
| Official MCP TypeScript SDK 1.32.2 client (`eval/sdk-client-check.mjs`) | Local | connect and initialize; `tools/list` (5 tools, all with input and output schemas); `list_briefs`, `get_build_brief` and `search_roles` results validated by the SDK against `outputSchema`; invalid arguments as a tool error; bad id as a tool error; unknown tool as a JSON-RPC error; `brief_for_job` progress notifications reaching `onprogress`, in increasing order, followed by the final result | 10/10 pass |
| MCP Inspector CLI 0.16.0 | Local | `tools/list` with schemas; `list_briefs`, `get_build_brief` and `search_roles` calls | Pass |
| Claude Code 2.1.330 | Production | `claude mcp get` health check (connect and initialize), and a real tool call: `claude -p` with `--mcp-config`, asked to call `search_roles` | Connected. The tool call returned 93 "founding engineer" roles. |
| curl | Local | `initialize` with protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, plus one unknown version; an unsupported `MCP-Protocol-Version` header | Each supported version is echoed back, the unknown one gets 2025-11-25, and the bad header gets 400 |
| `eval/smoke-http.mts` | Local, production and every 15 min against production | 13 HTTP checks (status codes, CORS, 202, 413, 405), plus `--live`: search, the home page, `/api/health` | Pass |

## Authentication

None, by design: One Link is public and read-mostly, and every write path is rate-limited and budget-capped. Clients connect without OAuth. A client that insists on OAuth discovery gets a 405 on `GET /mcp` and has no auth endpoints to find.

## Not verified (manual)

These need an interactive app session that wasn't available here. Don't claim compatibility with them until someone runs these steps:

| Client | Steps | What to check |
| --- | --- | --- |
| Claude Desktop | Settings → Connectors → Add custom connector → `https://one-link-eta.vercel.app/mcp` | The 5 tools appear. Ask for "a brief for a founding engineer role" and it calls `search_roles` then `get_build_brief` or `brief_for_job`. Check whether it shows progress during `brief_for_job`. |
| Cursor | Settings → MCP → Add server: `{"one-link": {"url": "https://one-link-eta.vercel.app/mcp"}}` | Tools listed and callable from the agent |
| ChatGPT | Settings → Connectors (developer mode) → add a custom MCP server with the URL above | Whether it accepts a server with no auth, and whether it calls the tools |

Progress notifications: the official SDK client receives them. Whether a given app *shows* them depends on that app, and not every client sends a progress token.
