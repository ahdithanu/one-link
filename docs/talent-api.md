# Data source: the speedrun talent network API

Checked on 2026-11-22.

## What One Link uses

| | |
| --- | --- |
| Base URL | `https://speedrun-talent-network.com/api/v1` |
| Endpoints used | `GET /jobs` (search: `scope`, `q`, `fn`, `page`), `GET /jobs/{id}` (detail with description) |
| Documented | Yes. The developer page is at `https://speedrun-talent-network.com/developers`, and there's an OpenAPI 3.1 spec at `/api/v1/openapi.json`. The API's root (`/api/v1`) links to both. |
| Authentication | None. Per the developer page: "No auth, no keys, no cost." The OpenAPI spec declares no security schemes. |
| Identification | The docs ask integrations to pass `?source=<your-integration>`. One Link sends `source=one-link` on every call, and `user-agent: one-link`. |
| Caching upstream | Edge-cached for 1 to 5 minutes (`cache-control: public, s-maxage=60, stale-while-revalidate=600` observed). |
| Usage limits | Not published as numbers. Per the developer page, "heavy anonymous scraping gets rate-limited at the edge." A fast crawl while building the eval dataset hit Cloudflare error 1015 (rate limited). |
| Paging | Lists are capped: `/jobs` stops at page 200 (about 10,000 of the roughly 22,000 to 24,000 roles listed on a given day), so One Link doesn't keep a full copy. |
| Terms | The site links a16z's general Terms of Use (`https://a16z.com/terms-of-use`). They haven't been reviewed here for API reuse, and that's not an engineering question. |

## How One Link calls it

All calls go through `getJson` in `lib/network.ts`:

- **Timeout:** 8 s per attempt. Uncached upstream searches measured 1.3 to 2 s, with one at 4.6 s; the worst case with the retry is about 16.5 s, inside the 60 s function limit.
- **Retry:** at most one, with 200 to 500 ms of jittered backoff. Only network errors, timeouts and 5xx are retried, never a 429, so their rate limit is respected.
- **Circuit breaker** (`lib/breaker.ts`):
  - Opens after 5 failures within 60 s, where a failure is a network error, timeout, 5xx or 429.
  - While open, it fails fast for 30 s, then lets one trial call through.
  - The trial closes the breaker if it succeeds, or reopens it if it fails.
  - A 404 is an answer, not an outage, so it doesn't count.
- **Caching:** searches are cached for 5 minutes and job details for 10, per instance. The last good copy of each is kept for up to an hour. If a fresh call fails (or the breaker is open), that copy is served and marked stale: `staleMinutes` on the web, `stale_minutes` in `search_roles`, and a sentence in the tool's text.
- **Metrics:** one log line per call, `{"event":"talent_api","op","ok","status","attempts","duration_ms","breaker"}`, plus `{"event":"talent_api_breaker","from","to"}` on every state change. Query text and job ids are never logged. `/api/health` reports the breaker's state and counters.

## Failure modes

| Failure | What users see |
| --- | --- |
| A slow or failed call | One retry, then the last good copy if there is one, marked stale. Otherwise search says the network didn't answer. |
| Sustained outage | The breaker opens. Searches seen in the last hour are served stale, new searches fail fast, and speedrun briefs and saved briefs keep working. |
| Rate limited (429) | No retry. It counts toward opening the breaker, which backs off for 30 s. |
| A job removed upstream (404) | That job's `/j/<id>` page returns 404. Nothing else changes. |
| An API change (fields or paging) | Search results or detail pages could break. Nothing currently detects this except the production smoke test, which runs a live search every 15 minutes. |

## Business dependency

This is a dependency on another organization's service, not just an engineering one:

- The API is public and invites integrations, but public access isn't the same as permission for any particular reuse. One Link writes and stores derived content (briefs) about each role and links back to the original listing.
- There's no agreement with the speedrun talent team, no published rate limit, and no notice period for API changes.
- Before sending real traffic, contact the team. Their developer page lists `write-sr-talent@a16z.com` for people building on the API. Confirm acceptable use, volume and attribution.
- One Link is independent and not affiliated with or endorsed by a16z or speedrun.
