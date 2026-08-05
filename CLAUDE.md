# FebBox Addon

## Purpose
Self-hostable Stremio addon providing direct FebBox-backed streams using each
user's own FebBox `ui` token. The addon operator does not proxy video bytes
or pay for bandwidth — each user consumes their own FebBox quota.

## Key directories
- `src/app` — current Express entry point (`npm start`), wires manifest/config/stream routes
- `src/providers/febbox` — FebBox client, auth, catalog, resolver, parser (see docs/IMPLEMENTATION_PLAN.md)
- `src/config` — encrypted per-user config token (AES-256-GCM)
- `src/security` — redaction, rate limiting
- `src/cache` — in-memory TTL cache (catalog + playback, separate)
- `src/metadata` — TMDB id conversion
- `test/unit` — mocked automated tests; `test/manual` — opt-in live FebBox test (needs `FEBBOX_UI_TOKEN`)
- `web/` — the config page: a real React app (Vite build), source at
  `web/src/App.jsx`. `npm run build` builds it into `views/public/`
  (gitignored — built fresh at deploy time), which Express serves as the
  site root. Not built automatically by `npm start` — run `npm run build`
  (or let Render's `buildCommand` in `render.yaml` do it) before starting
  if you've changed `web/`.
- `views/assets/` — addon icon (`icon.png`, `icon.svg`), served at `/assets/*`
- `docs/` — architecture, implementation plan, security, self-hosting, deployment docs

## Build / test / lint / start
- Install: `npm install`
- Start: `npm start` — requires `CONFIG_SECRET` env var, fails loudly without it
- Test: `npm test` (mocked, no credentials needed); `npm run test:manual` (opt-in, needs `FEBBOX_UI_TOKEN`)
- Lint: `npm run lint` (basic syntax check of new entry points)
- Deploy: see `docs/SELF_HOSTING.md`

## Security rules (non-negotiable)
- FebBox `ui` tokens are user credentials. Never log, commit, print, or place
  a real token in source, docs, fixtures, URLs, or terminal output.
- Never depend on the dead upstream services `febapi.nuvioapp.space` or
  `febbox.andresdev.org` — both are NXDOMAIN and must not be reintroduced,
  guessed-replacement domains included.
- Redact tokens from logs, errors, tracing, and analytics.
- Prefer an opaque signed/encrypted config token over embedding the raw
  FebBox token in the manifest URL.
- No arbitrary/open proxy endpoints; no user-controlled outbound destination
  URLs (SSRF risk).
- Do not commit `.env`, cookies, tokens, or captured private API responses.
- Verify every change (tests, manual route checks) before declaring it done;
  do not claim movie/series support that hasn't actually been verified against
  real behavior.
