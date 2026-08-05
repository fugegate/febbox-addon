# Contributing to FebBox Addon

Thanks for your interest in improving this project. This is a self-hosted
Stremio addon, so contributions that improve reliability, security, and
self-hosting ergonomics are especially welcome.

## Before you start

- Read [CLAUDE.md](CLAUDE.md) for the project layout and non-negotiable
  security rules (token handling, no dead upstream domains, no open proxies).
- Check [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for context on
  how the FebBox provider and Stremio routes fit together.
- Search existing issues before opening a new one.

## Development setup

```bash
npm install
npm test
```

- `npm start` runs the addon (requires a `CONFIG_SECRET` env var — see
  `.env.example`).
- `npm run test:manual` runs opt-in live tests against a real FebBox account
  (needs `FEBBOX_UI_TOKEN`) — do not run these in CI or share the output.
- The config page lives in `web/` (Vite + React). Run `npm run build` inside
  `web/` after changing it; `views/public/` is generated and gitignored.

## Security rules (must follow)

- Never commit, log, print, or paste a real FebBox `ui` token anywhere —
  source, docs, fixtures, commit messages, or issue/PR descriptions.
- Never reintroduce the dead upstream domains `febapi.nuvioapp.space` or
  `febbox.andresdev.org`, or any guessed replacement.
- Don't add arbitrary/open proxy endpoints or user-controlled outbound URLs.
- Redact tokens from logs, errors, and tracing.

If you find a security issue, please do not open a public issue — see
[docs/SECURITY.md](docs/SECURITY.md) for how to report it responsibly.

## Making changes

1. Fork the repo and create a branch off `main`.
2. Keep changes focused — one logical change per pull request.
3. Add or update tests under `test/unit` for any behavior change.
4. Run `npm test` and `npm run lint` before opening a PR.
5. Fill out the pull request template, including a test plan.

## Commit messages

Write clear, descriptive commit messages that explain *why* a change was
made, not just what changed.

## Code of Conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.
