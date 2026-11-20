# MCP client compatibility and conformance

Run on 2026-11-19 against the `fde-hardening` build, served locally with `next start -p 3210`.

## Official conformance suite

`npx @modelcontextprotocol/conformance@0.1.16 server --url http://localhost:3210/mcp --suite all`

| Scenario | Result | Why |
| --- | --- | --- |
| server-initialize | Pass | |
| ping | Pass | |
| tools-list | Pass | |
| resources-list | Pass | Returns an empty list |
| prompts-list | Pass | Returns an empty list |
| dns-rebinding-protection | Pass (2/2) | Failed before the Host allowlist was added |
| server-sse-polling, server-sse-multiple-streams | No checks run | The server answers with JSON and has no sessions, so these don't apply |
| tools-call-* (simple-text, image, audio, embedded-resource, mixed-content, error, progress, sampling, elicitation, with-logging), json-schema-2020-12, elicitation-* | Not applicable | Each scenario calls a fixture tool from the suite's reference server (`test_simple_text`, `test_error_handling`, ...). One Link correctly answers "Unknown tool" with -32602. |
| resources-read-*, resources-templates-read, resources-(un)subscribe, prompts-get-*, logging-set-level, completion-complete | Not applicable | Capabilities the server doesn't declare. It correctly answers -32601 Method not found. |

Totals as the tool reports them: 7 passed, 24 failed. All 24 failures are scenarios for features this server doesn't offer. Every scenario that applies to a tools-only server passes.

## Clients

| Client | What was checked | Result |
| --- | --- | --- |
| MCP Inspector CLI 2.16.0 (official) | `tools/list`; `tools/call list_briefs` with arguments; `tools/call get_build_brief` with a bad id | Pass. Lists all three tools, returns `structuredContent`, and the bad id comes back as `isError: true` with the validation message. |
| Claude Code 2.1.326 | `claude mcp list` health check against production (`https://one-link-eta.vercel.app/mcp`) | Connected. That is the deployed pre-change build. |
| Claude Code against the local build | Not completed. A project-scoped server needs a one-time interactive approval, and non-interactive `claude -p` couldn't authenticate from inside this session. | Not verified. |
| `eval/smoke-http.mts` (ours) | 13 black-box HTTP checks: status codes, headers, CORS, 202 for notifications, 413, 405 | 13/13 pass, local |
