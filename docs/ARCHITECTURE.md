# Architecture

## Overview
```
Stremio client
   │  GET /:configToken/manifest.json
   │  GET /:configToken/stream/:type/:id.json
   ▼
src/app (Express)
   ├─ src/config/configToken.js   decrypt opaque config -> {febboxToken, playbackMode}
   ├─ src/stremio/routes.js       route handlers
   │    ├─ src/metadata/tmdb.js         imdb -> tmdb (official TMDB `find`)
   │    │      + alternative/romanized titles for foreign-language matching
   │    ├─ src/providers/febbox/catalog.js   title search + FebBox share resolution
   │    │      resolveShareKeyForTitle(): ShowBox HTML search -> fuzzy match
   │    │      -> detail-page id -> share_link -> FebBox share key
   │    ├─ src/providers/febbox/resolver.js  share -> file list -> quality links
   │    │      └─ src/providers/febbox/client.js  first-party febbox.com HTTP calls
   │    │      └─ src/providers/febbox/parser.js  quality/codec/size parsing
   │    │      └─ src/providers/febbox/urlValidate.js  live-verifies each
   │    │         direct link (protocol/extension/Content-Type/host) before
   │    │         it's ever offered as a stream
   │    └─ src/cache/ttlCache.js  catalog/playback caches (separate, short TTL)
   ▼
Stremio stream objects (direct FebBox URLs, no proxying)
```

The config page (`web/`, a Vite/React app) is a separate static frontend,
built into `views/public/` and served by the same Express app. It calls
`POST /api/validate-token` and `POST /api/create-config` to produce the
per-user opaque config token embedded in the install URL.

## Discovery and playback modes
Given an IMDb id, `catalog.resolveShareKeyForTitle()` finds the matching
FebBox share by searching ShowBox's public site — see
`docs/CATALOG_DISCOVERY_RESEARCH.md` for the full mechanism and its
reliability testing. Once a share key is resolved, `resolver.js` lists its
files and resolves playable links:

- **`direct` mode (default)**: only FebBox's original ("ORG") file is
  offered — a direct, progressive link (`.mp4`/`.mkv`/`.m4v`/`.webm`),
  live-validated before being offered, that plays and seeks reliably.
- **`experimental-hls` mode (opt-in)**: only FebBox's transcoded quality
  tiers via unmodified HLS — no direct link. These have unreliable
  seeking in Stremio's web player; not something this addon fixes without
  proxying/re-transcoding video, which is out of scope.
- **`both` mode (opt-in)**: direct link(s) plus the HLS tiers together,
  direct listed first. For users who want the safe option available while
  also trying the additional HLS quality choices.

Playback mode is chosen per-user on the config page and stored in that
user's encrypted config token — see `src/config/configToken.js`.
