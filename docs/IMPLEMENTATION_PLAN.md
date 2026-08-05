# Implementation Plan — FebBox Addon

## 1. Starting point and known-dead dependencies

The project originally depended on two third-party endpoints for FebBox
catalog resolution:
- `FEBAPI_BASE_URL = 'https://febapi.nuvioapp.space/api/media'` — a
  third-party proxy API that did catalog lookup + FebBox resolution in one
  hop. NXDOMAIN, dead, unrecoverable, internal logic unknown.
- `https://febbox.andresdev.org/movie/950396` — used only as a
  cookie-validation shortcut. Also NXDOMAIN, dead.

Both are confirmed unreachable (DNS resolution fails); do not guess
replacement hostnames. The current implementation (`src/`) does not depend
on either — see §2 below for how catalog resolution actually works now.

Reused concepts: TMDB `find` for IMDb→TMDB conversion (a stable, documented,
official endpoint), and quality/codec/size parsing logic, both ported into
`src/providers/febbox/parser.js` and `src/metadata/tmdb.js`.

## 2. Research: three distinct FebBox problems

### Problem A — Find the ShowBox/FebBox content for a TMDB/IMDb title
**Status (updated 2026-08-04): IMPLEMENTED, best-effort. See
`docs/CATALOG_DISCOVERY_RESEARCH.md` for the full research trail that
superseded the "Cloudflare-gated, unimplementable" conclusion below — as of
2026-08-04 the `share_link` step answered directly over plain HTTP with no
Cloudflare challenge, so both steps could be implemented without any
browser-automation bypass. The narrative below is kept for historical
context on *why* this was originally believed unsolvable.**

There is no official or documented TMDB/IMDb → ShowBox/FebBox ID mapping.
Every open-source project found (e.g. `zainulnazir/showbox-febbox-api`,
`NotSujanSharma/show_feb_box_api`) does this the same fragile way:

1. Call ShowBox's undocumented **mobile app API** at
   `https://mbpapi.shegu.net/api/api_client/index/` — a reverse-engineered,
   proprietary, 3DES-encrypted request format with hardcoded app keys
   (`APP_KEY=moviebox`, fixed `KEY`/`IV` constants baked into every clone of
   this code). This is not a TMDB/IMDb lookup — it is a **free-text title
   search** (`Search5` module) that returns ShowBox's own internal `id`s.
   Matching a TMDB/IMDb title to the right ShowBox result requires fuzzy
   title/year matching (same class of problem as `fast-levenshtein` /
   `string-similarity`, already a dependency here) — there is no guarantee
   of a correct match, especially for remakes, franchises, or foreign titles.
2. Once a ShowBox internal `id` is known, the FebBox **share link** for it is
   fetched from `https://www.showbox.media/index/share_link?id=<id>&type=<type>`.
   This endpoint is **behind Cloudflare's interactive/JS challenge**. Every
   working example found runs a separate browser-automation bypass service
   (Playwright/Camoufox-based, e.g. the `bypass/` Python service shipped in
   `zainulnazir/showbox-febbox-api`) to solve it. That is a real, heavy,
   fragile dependency (headless browser infra, breaks whenever Cloudflare
   changes its challenge), not something to silently reproduce here.

**Original decision for v1 (superseded):** implement the shegu.net
search/detail calls behind a clearly-labeled best-effort catalog module,
but do not attempt step 2 (believed to require Cloudflare bypass).

**Updated decision (2026-08-04):** re-testing showed step 2
(`showbox.media/index/share_link`) is not currently Cloudflare-gated (see
`docs/CATALOG_DISCOVERY_RESEARCH.md`), so both steps are implemented in
`src/providers/febbox/catalog.js`: `search()` (unchanged) + `pickBestMatch()`
(fuzzy title/year/type scoring) + `getFebBoxShareKey()` (the previously-
blocked step) chained together in `resolveShareKeyForTitle()`. This remains
best-effort — a reverse-engineered, undocumented API that could re-add
protection at any time — and still fails soft (returns `null`, no match)
rather than guessing. Catalog auto-discovery is no longer a hard gap for
v1, but its live match accuracy across a wide range of real titles has not
been broadly stress-tested (only two example titles verified live so far;
see the research doc). A user-supplied FebBox share URL/key remains
available as a reliable fallback when discovery fails to match.

### Problem B — Resolve FebBox share content into a list of files
**Status: solved, uses FebBox's own public site API, not a third party.**

Given a FebBox share key (from a `https://www.febbox.com/share/<key>` URL),
the flow — confirmed by reading `zainulnazir/showbox-febbox-api`'s
`FebBoxApi.js` and cross-checked against this repo's own
`server.js` `/api/validate-cookie` flow — is:

```
GET https://www.febbox.com/file/file_share_list?share_key=<key>&pwd=&parent_id=0&is_html=0
Headers: Cookie: ui=<token>, x-requested-with: XMLHttpRequest, Referer: https://www.febbox.com/share/<key>
→ { data: { file_list: [ { fid, file_name, ... } ] } }
```
For folders, recurse with `parent_id=<folder fid>`. This is FebBox's own
site-internal AJAX endpoint (same origin as the share page itself), not a
third-party proxy — it does not depend on either dead domain.

### Problem C — Resolve a selected file into a playable URL using the user's token
**Status: solved, same first-party FebBox endpoint family.**

```
GET https://www.febbox.com/console/video_quality_list?fid=<fid>
Headers: Cookie: ui=<token>, x-requested-with: XMLHttpRequest, Referer: https://www.febbox.com/share/<key>
→ { html: "<div class='file_quality' data-url=... data-quality=... ...>" }
```
Response is an HTML fragment (`.file_quality` elements) with `data-url`,
`data-quality`, size, and name — parsed with `cheerio` (already a
dependency) into structured stream objects, direct `http(s)` URLs, no
further proxying needed. Confirmed as the mechanism this repo's own
`/api/validate-cookie` fallback path (`server.js` Step 3, `file/player`)
was already attempting, and matches the independent third-party
implementation above — two independent sources agree on the shape.

Quota/account check: `GET https://www.febbox.com/console/user_cards` with
the same cookie header returns `data.flow.{traffic_limit_mb,traffic_usage_mb}`
— already implemented correctly in this repo's `server.js:checkCookieQuota`
and reused as-is (first-party endpoint, not the dead domains).

**Important — unverified against live FebBox**: none of the above has been
exercised against a real FebBox account in this environment (no token was
available). All client code is written against the documented shapes above
and covered by mocked unit tests; the manual integration test
(`test/manual/febbox-live.test.js`) exists to verify it for real once a
token is supplied by the user, and auto-skips otherwise.

## 3. Proposed architecture

```
src/
  app/            express app wiring, error handling, security headers
  config/         opaque encrypted config token (AES-256-GCM), schema, defaults
  stremio/        manifest builder, stream route handlers
  metadata/       TMDB id resolution (imdb<->tmdb), title/year normalization
  providers/febbox/
    client.js     low-level HTTP client for febbox.com endpoints (B, C, quota)
    auth.js       token normalization + validateToken()
    quota.js      quota lookup wrapper
    catalog.js    best-effort ShowBox search (Problem A, step 1 only)
    resolver.js   movie/series file list -> quality-parsed stream objects
    parser.js     quality/codec/size parsing (ported from server.js)
    types.js      JSDoc typedefs
  security/       redaction, rate limiting, CORS/config, outbound allowlist
  cache/          in-memory TTL cache, optional Redis backend
  utils/
```

Legacy `server.js`/`addon.js`/`providers/*` remain in the tree for reference
during migration but the running app (`src/app`) does not import the dead
`Showbox.js` FEBAPI path. Unrelated scraper providers are excluded from the
v1 route wiring (kept as files only, not required by `npm start`).

## 4. Movie support
Movie stream requests: `imdbId`/`tmdbId` → best-effort catalog search
(Problem A) to find a FebBox share URL → Problem B (file list) → Problem C
(quality links) → Stremio stream objects. **Not verified against live
FebBox as of this writing** (mocked tests only). Users can alternatively
paste a known FebBox share URL directly via the config page as a reliable
fallback when catalog search fails.

## 5. Series/season/episode support
Same pipeline; FebBox shares for shows are typically nested folders
(show → season → episode file). `resolver.js` walks `file_share_list`
recursively by `parent_id`, matches season/episode numbers by filename
pattern (`S01E02`, `1x02`, etc. — reusing regexes already present in
`addon.js`). **Not verified against live FebBox** — same caveat as movies,
and folder-walking depth/pattern coverage is the biggest unverified risk.

## 6. Token handling
- Users paste their FebBox `ui` cookie value into the config page.
- Config page calls `POST /api/validate-token` (replaces the dead
  `febbox.andresdev.org` check) which uses Problem-C-adjacent first-party
  endpoints (`user_cards`) to confirm the token authenticates, without
  guessing a working share (avoids depending on any specific share still
  existing).
- On success, the server returns an **opaque encrypted config token**
  (AES-256-GCM, server-side secret from `CONFIG_SECRET` env var) encoding
  `{ febboxToken, quality prefs, createdAt }`. The manifest install URL
  embeds only this opaque token, never the raw FebBox cookie.
- `CONFIG_SECRET` missing in any environment → server refuses to start
  (fail loudly, no silent fallback to a default key).
- Decrypted token is held only for the duration of a single request; never
  logged. All logging goes through a redaction helper that strips `ui=`,
  `cookie=`, `token=` style values from strings before they reach the logger.

## 7. Personalized manifest design
`GET /:configToken/manifest.json` — `configToken` is the opaque encrypted
blob from §6. `GET /:configToken/stream/:type/:id.json` — same pattern,
matching Stremio SDK addon URL conventions already used by this repo.

## 8. Caching
- Catalog mapping cache (title/year/tmdbId → ShowBox id / FebBox share key):
  public, not token-specific, safe to share across users, longer TTL
  (e.g. 24h), in-memory `Map` with TTL, optional Redis via `REDIS_URL`.
- Playback URL cache: keyed by `(tokenHash, fid)`, short TTL (FebBox direct
  links expire), never persisted across processes without the token hashed,
  never shared cross-user, cleared on process restart if no Redis configured.
- Raw tokens are never used as cache keys directly — always SHA-256 hashed
  first.

## 9. Rate limiting & failure handling
- `express-rate-limit`-style per-IP limiting on `/manifest.json`,
  `/stream/*`, `/api/validate-token` (config page abuse / token brute force).
- FebBox client classifies errors: `AUTH_INVALID` (bad/expired token),
  `QUOTA_EXCEEDED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_ERROR`, `NOT_FOUND`. Movie
  and series handlers return an empty stream list (not a 500) plus a
  descriptive Stremio "no streams" style behaviorHint on auth/quota failure,
  never a raw exception to the Stremio client.
- Retries: only idempotent GETs, only on network-level timeouts/5xx, max 2
  retries with backoff; never retried on 401/403/429 (would hammer FebBox).

## 10. Deployment design
Same as upstream: single Node process, `npm start`, works on any host that
can run Node 18+. `.env` for `CONFIG_SECRET`, `TMDB_API_KEY`, optional
`REDIS_URL`. No Dockerfile changes required beyond documenting env vars in
`docs/SELF_HOSTING.md`.

## 11. Legal / ToS risk notes
- FebBox's own ToS is unknown/unverified from this environment; users are
  authenticating with **their own account token**, so the addon operator is
  not itself scraping FebBox anonymously, but redistributing a tool to do so
  still carries risk similar to other unofficial media-addon ecosystems.
  Document this plainly in README as a disclaimer — no legal advice given.
- The ShowBox mobile-API reverse-engineering (Problem A) uses
  hardcoded/reverse-engineered credentials from third-party open-source
  projects, not officially sanctioned access. Flagged as best-effort/legally
  gray in docs; not required for the addon's core value (users can supply
  share URLs directly).

## 12. Security threats considered
Token leakage via logs/URLs/errors; SSRF via user-controlled outbound URL
(mitigated: only fixed `febbox.com`/`shegu.net`/`themoviedb.org` hosts are
ever contacted, no user-supplied hostname is fetched); open proxy (not
built — direct URLs returned to Stremio, addon never proxies video bytes);
cross-user cache pollution (mitigated by hashed per-token cache keys);
config token forgery (mitigated by AEAD with server secret, not just base64).

## 13. Test strategy
Unit tests with mocked HTTP (`nock`/manual axios mocks) for manifest, stream
routes (movie/series), invalid IDs, missing/malformed token, config
encode/decode round trip, redaction, catalog lookup, resolver parsing (fed
fixture HTML/JSON, no real requests), FebBox auth failure, quota exhaustion,
rate limiting, timeout handling, quality ordering, and a snapshot/log-scan
test asserting no secret-shaped strings appear in captured output. Plus one
manual, opt-in, token-gated live integration test.

## 14. Migration steps
1. Add `src/` modules (this plan) alongside legacy files (done additively).
2. Wire a new minimal `src/app/index.js` entry point; `npm start` continues
   to point at `server.js` only until parity is confirmed, then switch.
3. Keep legacy `providers/*` (non-FebBox) untouched but unused/unrouted.
4. Document old file removal as a future cleanup once new path is trusted
   in production use (not done in this v1 to minimize risk of destructive
   changes without live verification).

## 15. Unresolved questions
- (Updated 2026-08-05) A TMDB/IMDb → FebBox mapping is implemented and has
  been **live-verified end-to-end** — one real movie (`tt1375666`) and one
  real TV episode (`tt0903747:1:1`), through the real Stremio-facing HTTP
  route, resolving to a range-probed `200 OK` playable stream. Note the
  mechanism changed after an earlier pass: the first implementation used
  ShowBox's mobile-app API
  (`mbpapi.shegu.net`, reverse-engineered 3DES + decompiled app keys),
  which was judged to be access-control circumvention on review and
  replaced with plain HTML search-page scraping instead (no crypto, no app
  secrets). It remains best-effort/reverse-engineered either way and could
  break if ShowBox changes its markup or re-adds protection; not
  stress-tested for rate limits/IP blocking at volume.
- FebBox endpoint shapes (Problems B/C) were inferred from third-party
  open-source code and this repo's own prior `/api/validate-cookie` logic,
  and have since been **live-verified** against a real FebBox account.
- Series folder-structure conventions on FebBox (nesting depth, filename
  patterns) are assumed from general FebBox/ShowBox community knowledge, not
  verified live.

## 16. Go / no-go criteria
- Go for release-as-beta: manifest + movie/series stream routes work against
  **mocked** fixtures, config encryption round-trips, no secrets appear in
  logs, `npm audit` reviewed, README honestly states catalog mapping is
  best-effort/unverified.
- No-go for claiming "catalog auto-discovery works": would require a
  verified, repeated, live test across multiple real titles with a real
  token, which has not been performed and is not achievable in this
  environment without one being supplied.
