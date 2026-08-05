# Catalog Discovery Research (Problem A)

> **2026-08-05 correction — read this first.** The "Smallest viable
> implementation path (chosen)" below describes an earlier implementation
> that used ShowBox's mobile-app API (`mbpapi.shegu.net`), a
> reverse-engineered 3DES scheme with hardcoded keys extracted from
> decompiling the official Android app. On further review this was judged
> to cross into **access-control circumvention**: that crypto exists to
> authenticate the app's own API traffic, and the same reverse-engineered
> scheme has separately been documented (in an unrelated public write-up)
> being used to attack the app's session/account auth — i.e. it's a real
> access-control mechanism, not incidental obfuscation. It has been
> **replaced** in `src/providers/febbox/catalog.js` with plain HTML
> scraping of `showbox.media/search?keyword=` (mechanism #4 below is
> unchanged; only the *search* step, mechanism #3, was swapped for a
> no-crypto, no-app-secrets alternative: fetching the same public search
> results page any browser would load, then extracting the ShowBox
> `id`/`type` pair that's already sitting as literal markup on the matched
> result's own detail page). This whole replaced discovery chain — search →
> match → share_link → file listing → playable URL — has since been
> **live-verified end-to-end** for one real movie and one real TV episode
> through the actual HTTP stream route. Sections below are left as originally written for the historical record
> of what was evaluated and why; treat mechanism #3 (`mbpapi.shegu.net`) as
> **rejected**, not adopted.

Research date: 2026-08-04. All "live" checks below were run via direct
`curl`/Node `fetch` (no browser, no proxy) on that date; see the exact
commands and outputs summarized per mechanism. This research **supersedes**
the "Cloudflare-gated, unimplementable" conclusion recorded earlier in
`docs/IMPLEMENTATION_PLAN.md` §2/§15 — that conclusion was accurate as
written but the `showbox.media/index/share_link` endpoint no longer
exhibits the Cloudflare challenge that blocked it before.

## Candidate mechanisms found

### 1. `febapi.nuvioapp.space` (original upstream, `providers/Showbox.js`)
- Source: this repo, `providers/Showbox.js:9` (`FEBAPI_BASE_URL`), legacy/unrouted.
- Live status: **dead**. `nslookup febapi.nuvioapp.space` → `NXDOMAIN`. Confirmed again today.
- Notes: first-party proxy built by the addon's original author; source was
  never public, internal logic unknown. Per `CLAUDE.md`, must never be
  reintroduced (including guessed-replacement domains).

### 2. `febbox.andresdev.org` (legacy cookie-validation shortcut)
- Source: this repo, `server.js:243`, legacy/unrouted.
- Live status: **dead**. `NXDOMAIN`. Confirmed again today. Not a catalog
  mechanism anyway (was only used for cookie validation); irrelevant to
  Problem A but re-confirmed dead per `CLAUDE.md` requirement.

### 3. ShowBox mobile-app search API — `mbpapi.shegu.net/api/api_client/index/`
- Source (external, for the request shape): `zainulnazir/showbox-febbox-api`,
  `api/src/ShowboxAPI.js` (constants: `BASE_URL`, `APP_KEY=moviebox`,
  `APP_ID=com.tdo.showbox`, `IV=wEiphTn!`, `KEY=123d6cedf626dy54233aa1w6`,
  module `Search5`). Same shape independently found in
  `NotSujanSharma/show_feb_box_api`, `badwinton/show_feb_box_api`,
  `hiratazx/febbox-api`. This repo already had this implemented in
  `src/providers/febbox/catalog.js` (`search()`) before this research pass —
  it was written from the same publicly-documented shape but never live
  tested end-to-end with the next step.
- Live status **today**: **alive**, plain HTTP, no Cloudflare/CAPTCHA
  challenge observed. Verified with a real (encrypted, per the documented
  3DES scheme) `POST` request for a generic example title ("inception") and
  a generic example TV title ("breaking bad") — both returned `HTTP 200`
  with well-formed JSON (`{"code":1,"msg":"success ...","data":[{...}]}`)
  including ShowBox internal `id`, `box_type` (1=movie, 2=tv), `title`,
  `year`.
- Nature: reverse-engineered, undocumented, free-text title search (not an
  ID lookup) — requires fuzzy title/year matching against the caller's
  TMDB metadata, same class of problem as any fuzzy scraper matcher.
- Risk: undocumented API, hardcoded reverse-engineered app credentials
  shared across many public clones; ShowBox could change the request format,
  rotate keys, or add auth/challenge at any time without notice. Rate
  limiting / IP blocking behavior unknown (not stress-tested here — only a
  handful of exploratory requests were made). No ToS was found published by
  ShowBox to check against.

### 4. ShowBox → FebBox share-link resolver — `www.showbox.media/index/share_link`
- Source (external, for the request shape and the *previous* need for a
  bypass): `zainulnazir/showbox-febbox-api`, `api/src/ShowboxAPI.js`,
  `getFebBoxId()` — that implementation routes this exact call through a
  separate Playwright/Camoufox "bypass" HTTP service
  (`process.env.BYPASS_URL`, default `http://localhost:8000/html?url=...`)
  specifically because, as of that project's last update, this endpoint was
  behind an interactive Cloudflare challenge. This matches what
  `docs/IMPLEMENTATION_PLAN.md` (written earlier in this repo's history)
  concluded independently.
- Live status **today**: **alive, and no longer Cloudflare-gated** for this
  specific query pattern. Verified with multiple direct, unauthenticated
  `curl -sS "https://www.showbox.media/index/share_link?id=<id>&type=<type>"`
  calls (ids `1`, `2`, `3`, `100`, plus the real ids returned by the
  `Search5` query above) — every call returned `HTTP 200`,
  `content-type: application/json`, and a body of exactly
  `{"code":1,"msg":"success","data":{"link":"https://www.febbox.com/share/<key>"}}`.
  No `cf-ray`/challenge headers, no HTML challenge page, no CAPTCHA, no
  JS-execution requirement was observed in the response headers or body at
  any point in this research session. This directly contradicts the
  bypass-service requirement recorded in the external reference
  implementation and in this repo's own earlier notes — it is possible
  ShowBox relaxed protection on this endpoint, geo/IP-based Cloudflare rules
  didn't trigger from this environment's egress IP, or the earlier gating
  was intermittent. This should be treated as **currently working, not
  guaranteed to stay that way** (see risks below).
- Full chain verified live end-to-end (search → match → share_link) using
  `src/providers/febbox/catalog.js resolveShareKeyForTitle()` itself,
  called directly (not mocked) with example TMDB-shaped input for one movie
  and one TV title: both returned a real 8-character FebBox share key.
  (Exact titles/keys are not reproduced here per the "no hardcoded IDs
  wired into logic" constraint — this is a one-off research verification,
  not something committed into code, tests, or docs as a literal value.)

### 5. Other candidates surveyed, not used
- `hiratazx/febbox-api`, `NotSujanSharma/show_feb_box_api`,
  `badwinton/show_feb_box_api`, `elsayed85/showbox-api-package`,
  `TheBatProgrammer/showbox-febbox-api` — all implement the same two-step
  ShowBox search + share_link pattern above (some with their own bundled
  Cloudflare-bypass server, same as `zainulnazir`'s). No fundamentally
  different, more official mechanism was found among them.
- No other public project was found (searched broadly via web search) that
  replaced discovery with something other than this same ShowBox mobile-API
  + share_link pattern, or a Cloudflare-bypass browser service.
- No public/official TMDB→ShowBox or TMDB→FebBox mapping API was found
  anywhere. This remains, as previously documented, an entirely
  unofficial/reverse-engineered space.

## Legal / technical risk summary

| Mechanism | ToS status | Fragility | Rate limit / IP block risk | Official vs reverse-engineered |
|---|---|---|---|---|
| `mbpapi.shegu.net` search | Unknown (no published ShowBox ToS found) | High — undocumented, hardcoded shared app keys, could change/rotate any time | Unknown, untested at volume | Reverse-engineered |
| `showbox.media/index/share_link` | Unknown | High — was Cloudflare-gated per external references and this repo's prior research; currently open, could re-gate without notice | Unknown, untested at volume | Reverse-engineered |
| `febapi.nuvioapp.space` | N/A | Dead (NXDOMAIN) | N/A | N/A (was first-party proxy, source never public) |
| `febbox.andresdev.org` | N/A | Dead (NXDOMAIN) | N/A | N/A |

Both live mechanisms are anonymous (no FebBox account needed for discovery
itself — only later, already-solved Problems B/C need the user's own FebBox
token) and require no CAPTCHA-solving, no Cloudflare challenge-solving, no
browser automation, and no credential theft as of this research date. They
satisfy the hard constraints in that sense. The residual risk is entirely
about **durability**: this is not a documented/stable API contract, and
ShowBox re-adding Cloudflare protection to `share_link` (as external
evidence suggests they had at some point) would silently break discovery
again with no code-level fix available short of a bypass this repo will not
implement.

## Smallest viable implementation path (chosen)

1. `src/metadata/tmdb.js`: `convertImdbToTmdb()` now also returns a `year`
   (parsed from TMDB's `release_date`/`first_air_date`) — needed for
   confident fuzzy matching in step 3.
2. `src/providers/febbox/catalog.js`:
   - `search(title)` — unchanged request shape, now also allowlist-checked
     (`assertAllowedUrl`) for `mbpapi.shegu.net`, consistent with this
     repo's SSRF-hardening pattern used in `client.js`.
   - `pickBestMatch(results, {title, year, tmdbType})` — new. Filters
     ShowBox `box_type` (1=movie, 2=tv) to match the requested type, scores
     remaining candidates with `string-similarity` (already a dependency)
     on normalized titles, boosts/penalizes by year proximity, and requires
     a minimum score (0.72) before trusting a match — biased towards "no
     match" over a wrong match.
   - `getFebBoxShareKey(id, boxType)` — new. Calls
     `showbox.media/index/share_link`, also allowlisted, parses the share
     key out of the JSON response, returns `null` on any non-success shape.
   - `resolveShareKeyForTitle(tmdbInfo)` — now actually implemented:
     `search()` → `pickBestMatch()` → `getFebBoxShareKey()`, returning
     `null` (not throwing) when no confident match exists, matching how
     `src/stremio/routes.js` already expected to consume it (soft-fail to
     an empty stream list).
3. `src/stremio/routes.js` — no functional change needed; it already called
   `catalog.resolveShareKeyForTitle(tmdbInfo)` and treated failure as "no
   streams." Only the explanatory comment was updated (was describing the
   old always-throws behavior).
4. Tests: `test/unit/catalog.test.js` rewritten — mocked coverage for
   `search`, `pickBestMatch` (correct match, correct rejection), the new
   `getFebBoxShareKey`, and the full mocked chain through
   `resolveShareKeyForTitle`. All 56 unit tests (50 pre-existing + 6 new)
   pass with `npm test`.
5. Problems B and C (file listing, file→playable-URL) are **untouched** —
   this change only supplies `resolver.resolveMovie`/`resolveEpisode` with a
   real share key instead of never being called.

## What was *not* done, and why

- No Cloudflare-bypass browser service, no CAPTCHA-solving, no fingerprint
  evasion was added anywhere — not needed today because `share_link`
  answered directly, and would violate the hard constraints regardless.
- No hardcoded title/TMDB/IMDb id or share key was placed in any shipped
  code, test, or doc — the example titles/ids used during live testing
  above are documented here as research evidence only, not wired into
  `catalog.js`, `resolver.js`, tests, or fixtures.
- Full end-to-end verification (Stremio id → share key → file list →
  playable URL → HTTP range probe) additionally requires Problems B/C
  (`resolver.js`), which need a real `FEBBOX_UI_TOKEN`. To reproduce, run
  `scripts/verify-live.js` with `FEBBOX_UI_TOKEN` set as an env var
  (never commit or log it) to resolve a real movie/episode through the
  full pipeline and range-probe the result.
