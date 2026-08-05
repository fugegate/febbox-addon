# FebBox Addon

A self-hosted Stremio addon that streams movies and TV shows from FebBox's
catalog, using your own FebBox account to access it. You provide your own
FebBox token, movies and TV episodes are looked up automatically from their
IMDb/TMDB id, and playback streams directly from FebBox to your device —
this addon never proxies or stores your video traffic. You aren't limited
to content you've personally uploaded to FebBox; every byte streamed just
counts against your own account's quota instead of the addon operator's.

## Features

- **Movie and TV episode lookup** — give it a Stremio/IMDb id, it finds the
  matching FebBox content automatically. No manual share links needed.
- **Direct playback by default** — streams FebBox's original file, which
  plays and seeks reliably in Stremio.
- **Your own account, your own quota** — the addon operator never sees or
  pays for your video bandwidth.
- **Private by design** — your FebBox token is encrypted before it's ever
  part of your install URL, and is never logged or sent to any third party.
- **Self-hosted** — run it yourself, on your own infrastructure.

## Quick start

1. Deploy your own instance (see [Deployment](#deployment) below), or run
   it locally (see [Local development](#local-development)).
2. Open the config page and paste your FebBox `ui` token — the page
   explains exactly where to find it.
3. Click **Generate install link**, then paste that URL into Stremio
   (Addons → the puzzle-piece icon → paste URL → Install).
4. Search for any movie or TV show in Stremio as usual — matching streams
   from FebBox's catalog will appear alongside other sources.

## How it works

1. Stremio sends this addon a movie or episode's IMDb id.
2. The addon looks up the title on TMDB, searches for a matching entry, and
   resolves it to a FebBox share.
3. It lists the files in that share and returns direct, playable stream
   URLs — sourced from FebBox's original ("ORG") file by default, since
   that's the version confirmed to seek correctly. An **Advanced** option
   on the config page can additionally offer FebBox's transcoded quality
   tiers (1080p/720p/etc.) via HLS — these are known to have unreliable
   seeking in Stremio's web player, which is why they're opt-in rather than
   default.

Because this uses ShowBox's public search rather than a documented API, it
occasionally won't find a match for an obscure title, and could stop
working if ShowBox changes its site. When it can't find a confident match,
it simply returns no streams rather than guessing wrong.

## Your token, and your privacy

Each user pastes their own FebBox `ui` token into the config page. It's
sent only to this server and to FebBox itself — never to analytics or any
third party — and is encrypted (AES-256-GCM) into an opaque token before
it appears anywhere in your Stremio install URL, so the raw token is never
exposed. Treat your token like a password: it's an account credential.
See [docs/SECURITY.md](docs/SECURITY.md) for the full details.

## Local development

```bash
npm install
npm run build   # builds the config page
cp .env.example .env
# set CONFIG_SECRET (required) — generate one with:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```
See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for full setup, required
environment variables, and how to verify a local install.

## AIOStreams compatibility

Install this addon's manifest URL into AIOStreams the same way as any
other Stremio addon — stream objects include the standard
`behaviorHints.filename`/`bingeGroup` fields AIOStreams uses for
quality/language parsing.

## Known limitations

- Catalog lookup (matching a title to FebBox content) is best-effort — it
  can occasionally miss an obscure title, and depends on ShowBox's public
  site staying in its current shape.
- Episode matching relies on filename patterns (`S01E02`, `1x02`); unusual
  FebBox folder layouts for a show may not match correctly.
- FebBox's transcoded HLS quality tiers are available but not offered by
  default — see "How it works" above.

## Legal

This addon does not host, scrape, or redistribute video content — it
resolves direct links from FebBox using credentials you supply for your
own FebBox account. You're responsible for complying with FebBox's terms
of service and your local laws. No warranty is provided; this project is
offered as-is for personal, self-hosted use. Licensed under MIT — see
[LICENSE](LICENSE).

## More docs
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the system fits together
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and token handling
- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) — full local setup and deployment
