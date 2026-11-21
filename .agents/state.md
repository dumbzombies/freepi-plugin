# State

## Goal

Provide free-pi (freepi.ai) as a native pi/omp provider: GitHub device login, quota/status
commands, `freepi_quota` tool, and an in-process OpenAI-compatible API that preserves ad billing,
session rotation, and response caching.

## Progress

- `src/` implements config, upstream client, token/device login, session lifecycle, exact-response
  cache, Gravity ads, loopback server, and the extension entry (`index.ts`).
- Provider `freepi` registered with free-pi-cli 0.6.25 metadata; `/login freepi` verified with
  account `@dumbzombies`.
- Commands: `/freepi` (status summary, plus `quota|models|login|server|help`),
  `/freepi-quota` (quota only), `freepi_quota` tool. Subcommands complete via
  `getArgumentCompletions`.
- `scripts/probe-context.mjs`: `deepseek-v4.1-flash` accepts ~213,363 prompt tokens before
  `context_too_long`.
- `scripts/probe-billing.mjs`: all 27 models classified — 4 free, 6 quota-charged, 17 premium-only.
- Tests: `npm test` → 2 pass, 0 fail.
- Commits: `81dc32b`, `ac6b261`, `70f929b`, `77fd98e`, `2961356`. Worktree clean.
- Plugin linked into omp with `omp plugin link ~/projects/freepi-plugin`.

## Blockers

None.

## Next actions

- None pending. Push to a private GitHub repo only if the user asks.
