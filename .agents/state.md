# State

## Goal

Provide free-pi (freepi.ai) as a native provider in two hosts — pi/omp (full extension) and
opencode (static provider + shared loopback server) — with GitHub device login, quota/status
commands, and an OpenAI-compatible API that preserves ad billing, session rotation, and
exact-response caching.

## Progress

### Core (`src/`)

- `config.ts` (env + paths), `upstream.ts` (catalog, completions, ads), `token.ts` (device login,
  token file), `state.ts` (session lifecycle, quota view), `cache.ts` (exact-response cache),
  `gravity.ts` (ad pixel), `settings.ts`, `visibility.ts`, `server.ts` (loopback HTTP).
- Shared, host-neutral modules: `format.ts` (quota rendering), `models.ts` (catalog → model view,
  `providerModels`), `runtime.ts` (`ensureServer`, `effectiveSettings`, `applySettings`).
- `index.ts` is the pi/omp extension entry: registers provider `freepi`, `/freepi`
  (`quota|models|config|settings|login|server|help`), `freepi_quota` tool, `session_start` notice.
- Default-visible models: 10 (4 free + 6 allowance-charged), via `visibility.ts`.

### Servers and scripts

- `scripts/serve.mjs` — standalone loopback server (`node scripts/serve.mjs`). Runs as the runit
  service `freepi-loopback` (`sv status freepi-loopback`) so opencode always has a live endpoint.
- `scripts/login.mjs` — GitHub device login, prints URL + code, writes `~/.freepi-plugin/token`.
- `scripts/quota.mjs` — prints the quota report (used by the opencode command).
- `scripts/opencode-provider.mjs` — emits the opencode `provider.freepi` JSON block from the live
  catalog (10 models, context 200000, output 32768, zero cost).
- `scripts/probe-context.mjs`, `scripts/probe-billing.mjs` — one-off probes (unchanged).

### opencode integration (verified working)

- `~/.config/opencode/opencode.jsonc` → `provider.freepi`: `npm: @ai-sdk/openai-compatible`,
  `options.baseURL: http://127.0.0.1:8473/v1`, `options.apiKey: freepi`, 10 models.
- `~/.config/opencode/plugins/freepi.ts` — id `freepi.in-process`. Metadata only: this opencode
  build validates `id` + `setup` and never calls the exported `server` hook.
- `~/.config/opencode/command/freepi-quota.md`, `freepi-login.md` — shell out to the scripts.
- `opencode models` lists all 10 `freepi/*` ids; `opencode run -m freepi/<model> "…"` completes.

### omp integration (verified working)

- Linked with `omp plugin link ~/projects/freepi-plugin` (`~/.omp/plugins/node_modules/freepi-plugin`).
- `omp models` shows `freepi (10)`; `omp -p --model freepi/deepseek-v4.1-flash` completes.

### Tests

`npm test` → **16 pass, 0 fail**:
- `test/server.test.mjs` — health/models/401 gates.
- `test/settings.test.mjs` — defaults, validation, round-trip, cache cap, model filters, premium.
- `test/server-stream.test.mjs` — upstream socket destroyed mid-stream must not hang the client.
- `test/server-auth.test.mjs` — placeholder `apiKey` falls back to the token file; the JWT is what
  goes upstream.
- `test/cache.test.mjs` — key normalization, disk hits across instances, memory-vs-disk labels, TTL.
- `test/cache-shared.test.mjs` — two writers merging one index.
- `test/cache-evict.test.mjs` — byte-cap eviction is not undone by the merge.

## Blockers

None.

## Next actions

- Regenerate the opencode provider block (`node scripts/opencode-provider.mjs`) after a free-pi
  catalog change, since opencode reads provider models only from static config.
- Push to a private GitHub repo only if asked.
