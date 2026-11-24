# Runbook

How One Link is deployed, checked, rolled back and watched. Production is `https://one-link-eta.vercel.app` (Vercel project `one-link`, region `iad1`).

## Deploying

The Vercel project isn't connected to Git, so merging to `main` deploys nothing. Production changes only through one of these:

1. **The Deploy workflow (recommended).** Actions → Deploy → Run workflow → `preview` or `production`.
   - It runs typecheck and tests, builds with the Vercel CLI, deploys, then runs the live smoke test (including `/api/health`) against the result.
   - Production runs in the `production` GitHub environment. Add yourself as a required reviewer there and every production deploy waits for your approval.
2. **The CLI, by hand:** `vercel deploy --prod` from an up-to-date `main`, then the verification below.

Only deploy `main` after its CI has passed: unit tests, the cross-process Redis tests, a build, the HTTP smoke test and the MCP conformance gate.

### One-time setup for the Deploy workflow (owner only)

1. Create a Vercel token: vercel.com → Account Settings → Tokens. Scope it to the team that owns `one-link`.
2. In GitHub: Settings → Secrets and variables → Actions, add:
   - `VERCEL_TOKEN`: the token.
   - `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`: the values in `.vercel/project.json` after `vercel link`.
   - `VERCEL_AUTOMATION_BYPASS_SECRET`: only if preview deployments are protected. Find it in Vercel → Project → Settings → Deployment Protection → Protection Bypass for Automation.
3. In GitHub: Settings → Environments → `production` → Required reviewers → add yourself.

### Alternative: Vercel's Git integration

Vercel → Project → Settings → Git → Connect `ahdithanu/one-link`. That gives every PR a preview deployment automatically. It also deploys every push to `main` to production, so pair it with branch protection on `main` that requires the CI checks and a review before merge.

## Checking a deployment

```bash
node --experimental-strip-types eval/smoke-http.mts https://one-link-eta.vercel.app/mcp --live
curl -s https://one-link-eta.vercel.app/api/health
npm run check:env      # required Vercel env var names are present (values are never read)
```

`/api/health` reports whether rate limits are global, Redis reachability, today's budget use, whether a model key is configured, and the talent API circuit. Anything weaker than intended is listed under `degraded`.

## Rolling back

Vercel keeps every deployment, so a rollback is instant and needs no rebuild:

```bash
vercel ls one-link --prod            # recent production deployments, newest first
vercel rollback                      # back to the previous production deployment
vercel rollback <deployment-url>     # or to a specific one
```

Then rerun the checks above. A rollback doesn't touch data: Blob and Redis are shared across deployments. Undo a rollback with `vercel promote <deployment-url>`.

## Incidents

| Symptom | Check | What to do |
| --- | --- | --- |
| Monitor email: smoke test failed | Run the smoke test locally against production | If MCP or pages fail after a deploy, roll back. If only `search_roles` fails, see the talent API row. |
| `/api/health` limits say `per-instance` | `limits.redis.reachable` | If false: check the Upstash console for an outage or exhausted quota. Limits still apply per instance. If Redis isn't configured, see "Connecting Upstash". |
| Talent API circuit `open` | Their status (`https://speedrun-talent-network.com/api/v1`) | Nothing to do: searches seen in the last hour are served stale and the breaker retries every 30 s. If it lasts, tell users in the README or on the home page. |
| Many `model_error` or `model_rate_limited` | Anthropic status page, console usage | Briefs fail with a clear message, and ready-made briefs keep working. If spend is the problem, lower `DAILY_BRIEF_CAP` and redeploy. |
| `budget_exhausted` all day | `/api/health` `dailyBudget` | Working as intended. Raise `DAILY_BRIEF_CAP` only after checking spend. |
| `budget_unavailable` | Redis or Blob reachability | New briefs pause until the budget can be checked again (fail closed). |
| Cost spike | `npm run report:logs` on recent logs (`model_spend`), Anthropic console | Lower `DAILY_BRIEF_CAP`, or remove `ANTHROPIC_API_KEY` to switch generation off (reads keep working). Keep a monthly spend limit set on the Anthropic workspace as the hard ceiling. |

## Metrics

Every request writes one JSON log line: `mcp_request` for MCP, `web_request` for the brief routes. There's also `talent_api` per upstream call, `talent_api_breaker` on each breaker change, and `rate_limit_fallback` or `brief_lock_fallback` when Redis can't be used. No line contains job text, tool arguments, IPs or keys.

```bash
vercel logs https://one-link-eta.vercel.app --json > logs.jsonl   # recent runtime logs
npm run report:logs -- logs.jsonl
```

The report gives:
- MCP availability
- success rate and p50/p95 latency per tool and route
- brief generation success rate
- model failures by kind
- rate-limit rejections
- budget refusals
- talent API failure rate, p50/p95 and breaker opens
- Redis fallbacks
- model tokens and an estimated cost at current list prices

`vercel logs` only covers recent logs. For history, add a log drain (Vercel → Project → Settings → Log Drains) to a log service. That needs an account with that service.

## Usage analytics

- Visitors: Vercel → `one-link` → Analytics. Web Analytics is enabled on the project, and the free plan covers this traffic.
- Agent usage and unique MCP callers: `https://one-link-eta.vercel.app/stats`. It needs Upstash connected (see below) and a `STATS_KEY` of 16 or more characters, added in Vercel → Settings → Environment Variables → Production, followed by a redeploy. Rotating `STATS_KEY` logs out every open session.

## Alerts

- **Today:** the production monitor (`.github/workflows/monitor.yml`) runs the live smoke test every 15 minutes, retries once, and fails the run on a real problem. GitHub emails the repository owner when a scheduled run fails.
- **Phone alerts without new accounts:** install the GitHub mobile app, sign in, and turn on push notifications for Actions (Settings → Notifications → Actions → "Only notify for failed workflows" on both web and mobile). A failed monitor run then reaches your phone.
- **Require global limits:** after connecting Upstash, set the repository variable `EXPECT_GLOBAL_LIMITS=1` (Settings → Secrets and variables → Actions → Variables). The monitor then fails if limits fall back to per instance.
- **Paging service (optional):** for alerts on error rate or p95 latency, send a log drain to a service such as Better Stack or Datadog and alert on the `mcp_request` and `web_request` lines. That needs an account and possibly a paid plan, so it isn't set up.

To keep noise low: the monitor alerts only on hard failures, after one retry. Latency and error-rate alerts should use 15-minute windows, not single requests.

## Connecting Upstash (global limits)

1. Vercel → `one-link` → Storage → Create Database → Upstash for Redis. The free plan is enough. Choose the region nearest `iad1` (US East) and connect it to Production. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. Redeploy production. Environment variables only load into new deployments.
3. Check that `/api/health` shows `"scope": "global"` and `"reachable": true`, and that `npm run check:env` shows Redis as ok.
4. Set the repository variable `EXPECT_GLOBAL_LIMITS=1`.

## Data retention

The policy lives in `lib/retention.ts` and is unit tested. A dry run lists what it would remove and why, and deletes nothing:

```bash
vercel env run -e production -- npx tsx scripts/cleanup.mts
```

| Data | Policy | Tradeoff |
| --- | --- | --- |
| `board/latest.json` | Keep (overwritten daily) | The live board |
| `briefs/<id>.json` (pasted posts) | Keep | They're share links people may have sent to a founder. They're small (23 so far), and deleting one breaks a link without warning. |
| `jobbriefs/<job>.json` (network roles) | Remove 30 days after the role closes | Shared by everyone while the role is live. The grace period covers links sent just before it closed. Unknown status always keeps. |
| `spend/<day>/…` markers | Remove after 2 days | Only today's markers count toward the budget (when Redis isn't configured) |
| `events/<name>/…` usage events | Keep | They're the counts on `/why`, so deleting them would change public numbers. If they grow large, roll them up into one count file per event and teach `countEvents` to read it, then delete the raw files. |
| Redis keys | Expire on their own | Rate limits after 1 h, the budget after 2 days, locks after 90 s |

The first dry run against production (2026-11-22) found 264 blobs (539 KB) and would remove nothing. Deleting needs both `--apply` and `CONFIRM_DELETE=yes`, and should only follow a reviewed dry run.
