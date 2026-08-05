# Security

## Threat model summary
- FebBox `ui` tokens are account credentials. The addon operator (self-hoster)
  never sees them in plaintext beyond a single request's in-memory lifetime.
- Untrusted input: Stremio stream requests (`type`, `id`) and the config page
  (`token`, `quality`). All are validated before use.
- No arbitrary outbound destinations: `src/providers/febbox/client.js` only
  ever calls a hardcoded `https://www.febbox.com` origin
  (`ALLOWED_HOSTS`/`FEBBOX_ORIGIN`); `src/providers/febbox/catalog.js` only
  calls a hardcoded `www.showbox.media`; `src/metadata/tmdb.js` only calls
  `api.themoviedb.org`. No user input ever selects a hostname to fetch — this
  is the primary SSRF mitigation.
- No open proxy: the addon returns FebBox's own direct URLs to Stremio; it
  never proxies video bytes itself.

## Token handling
- Users paste their FebBox `ui` token into the config page (`web/`).
- `POST /api/create-config` normalizes/validates the token shape
  (`src/providers/febbox/auth.js`) and encrypts it with AES-256-GCM
  (`src/config/configToken.js`) using a server-side `CONFIG_SECRET`. The
  resulting opaque token — not the raw FebBox cookie — is what appears in the
  Stremio manifest install URL.
- `CONFIG_SECRET` must be set to a string of at least 16 characters (32+
  recommended). If unset or too short, `src/app/index.js` throws on startup
  and the server refuses to boot — there is no silent fallback to a default
  or hardcoded key.
- Decrypted tokens exist only for the duration of a single request/response
  cycle; they are never written to disk, cache, or logs in plaintext.
- Cache keys derived from tokens always use `hashToken()` (SHA-256), never
  the raw token (`src/config/configToken.js`, `src/cache/ttlCache.js`).

## Redaction
`src/security/redact.js` strips `ui=`, `cookie=`, `token=`, `config=`,
`authorization=` style substrings from strings, deep-redacts object keys
matching common secret names, and is applied to every error before logging
in `src/app/index.js` and `src/stremio/routes.js`. `test/unit/redact.test.js`
and `test/unit/app.test.js` assert secret-shaped strings never appear in
logs or HTTP responses for the cases tested.

## CORS / headers
- CORS is open on `origin` (Stremio desktop/mobile clients call from many
  local origins and don't send cookies), but `credentials: false` — no
  cookie-based session exists to leak.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` set on all responses.

## Rate limiting
`src/security/rateLimit.js` is a minimal in-memory fixed-window limiter
applied to `/api/validate-token`, `/api/create-config` (30 req/min/IP) and
stream routes (120 req/min/IP). For a multi-instance deployment, put a real
reverse-proxy rate limiter in front instead of relying solely on this.

## Input validation
- FebBox token: length bounds (8–512 chars), rejects control characters
  (`\r\n\t`) to prevent header injection (`src/providers/febbox/auth.js`).
- Stremio `id` param: must start with `tt` (IMDb format) or the request is
  rejected with an empty stream list.
- Config token: AES-GCM authentication tag verification means a
  tampered/forged config token fails to decrypt rather than being accepted.

## Failure handling
FebBox client errors are classified (`AUTH_INVALID`, `QUOTA_EXCEEDED`,
`UPSTREAM_TIMEOUT`, `UPSTREAM_ERROR`, `NOT_FOUND`, `RATE_LIMITED` —
`src/providers/febbox/types.js`). Stream routes catch all of these and
return `{ streams: [] }` to the Stremio client rather than a 500 or a raw
stack trace. Retries (`src/providers/febbox/client.js`) only happen for
network-level transient errors (timeout/reset/DNS), never for 401/403/429,
to avoid hammering FebBox with bad credentials or during rate limiting.

## Known gaps / not done in v1
- `npm audit` reports pre-existing high/critical findings in the *inherited*
  legacy dependency tree (`vm2`, `ws` via `puppeteer`) used only by the old
  `server.js`/`addon.js`/`providers/*.js` scraper pipeline, which the new
  `src/app` entry point does not import or route to. These are flagged, not
  fixed, in this v1 — removing/upgrading the legacy scraper stack is future
  work (see docs/IMPLEMENTATION_PLAN.md §14 migration steps).
- No CSRF tokens on the config page's POST endpoints: these endpoints don't
  use cookie-based auth (no ambient credential to forge a request with), so
  classic CSRF doesn't apply the same way it would to a session-cookie app;
  still, if you deploy this behind auth of your own, add CSRF protection at
  that layer.
## Config page
The config page (`web/`) is a React app — dynamic values (the install URL,
status messages) are rendered as text, not via `innerHTML`, so there's no
HTML-injection surface from user-entered or server-returned content.

## `/security-review` results
Checked: crypto misuse in `configToken.js` (IV reuse, missing auth-tag
verification, key derivation), SSRF (host/protocol control, not just path)
in `client.js`/`catalog.js`/`tmdb.js`, header injection via token into
`Cookie`/`Referer`, XSS on the config page, auth bypass in the stream
route, secret exposure in logs/API responses, path traversal, unsafe
deserialization. **No high-confidence (>=8/10) findings.** Notably:
AES-256-GCM IV is randomized per call and never reused; auth tag is
verified on decrypt (tamper causes decrypt to throw); `client.js` only
ever calls a hardcoded `www.febbox.com` origin regardless of input; API
responses never return the raw FebBox token.
