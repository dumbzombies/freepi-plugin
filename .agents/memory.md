# Memory

## 2026-11-20 — Project shape and purpose

`freepi-plugin` is a pi/omp extension (not a standalone daemon) forked from `~/projects/freepi-proxy`.
It exposes free-pi (freepi.ai) as a native provider plus commands and an in-process
OpenAI-compatible server.

- Zero runtime dependencies, ESM, TypeScript run directly by Node ≥ 22.19 with type stripping.
- `package.json` carries both `pi.extensions` and `omp.extensions` → `src/index.ts`.
- Data dir `~/.freepi-plugin` (`FREEPI_PLUGIN_DATA_DIR`): `token`, `session-id`, `client-version`,
  plus probe outputs.
- The plugin owns `~/.freepi-plugin/token`; it must not overwrite `~/.free-pi/agent/credentials.json`.
- `npm test` runs `node --test test/*.test.mjs`.

## 2026-11-20 — Provider registration and server lifecycle

- Provider id `freepi`, API `openai-completions`, base URL `http://127.0.0.1:<port>/v1`.
- Server starts once per host process via `ensureServer()`; preferred port 8473
  (`FREEPI_PLUGIN_PORT`), probing upward 20 attempts. Observed sessions bind 8473–8475.
- Binds loopback only.
- Login uses the GitHub device flow: canonical `onAuth` plus legacy `onDeviceCode` callback.
  Device URL prints as `https://github.com/login/device?user_code=…`.
- Model metadata mirrors free-pi-cli 0.6.25: `contextWindow: 200_000`, `maxTokens: 32_768`,
  `reasoning: true`, `compat.supportsDeveloperRole: false`.

## 2026-11-20 — Metering and ad invariants

- Every completion turn must run `/ads/next`, optionally the Gravity pixel, then `/ads/impression`.
  Never bypass, spoof, or hide ad/impression reporting or metering.
- Local estimate: `(prompt + completion) * multiplier * 0.00222` credits
  (`EST_CREDITS_PER_TOKEN`). Catalog: 15,000 credits/day ≈ $1.125.
- Upstream 4xx/5xx pass through and are never cached. Only documented spent-session errors retry,
  once, with a fresh session.

## 2026-11-20 — Context window observed

`scripts/probe-context.mjs` on `deepseek-v4.1-flash`: ~213,363 prompt tokens accepted; next step
rejected with `context_too_long`. Boundary ~213k–240k; declared 200k is conservative. Results in
`~/.freepi-plugin/context-probe.json`.

## 2026-11-21 — Billing classification (27 models)

`scripts/probe-billing.mjs` sends one small ad-attributed turn per model and polls `/me/stats`.
One upstream session is reused; if 4 live CLI sessions exist, the account returns 409 until
`POST /session/reset` or lease expiry.

Bucket 1 — no quota hit (catalog `free: true`): `particle`, `deepseek-v4.1-flash`,
`glm-5.3-flash`, `deepseek-v4-flash`.

Bucket 2 — charged against the daily allowance: `gpt-oss-20b`, `hy4-flash`, `ling-3.0-flash`,
`ling-3.1-flash`, `qwen3.7-flash`, `solar-mini-4`.

Bucket 3 — `403 model_requires_credits` without purchased premium credits: every other catalog model
(all ≥1.6x plus `mimo-v2.6-flash`).

Gotcha: the CLI premium-refusal message calls `hy4-flash` free, but it bills (4000-token prompt
cost 3 credits). Catalog `free` is the authoritative no-charge signal. `deepseek-v4-flash` is free
by catalog, so there is no paid model that avoids the allowance.

`--plan` prints worst-case cost; `--model`/`--models`/`--all` select probes; `--budget` stops early.

## 2026-11-21 — Command surface and autocomplete

- `/freepi` with no args = summary: server URL, model/free counts, login state, handle·tier,
  one quota line, hint line. Subcommands `quota`, `models`, `login`, `server`, `help`.
- `/freepi quota` and `/freepi-quota` show the full quota report. Do not fold the default view back
  into the quota view.
- Argument completion uses `getArgumentCompletions(prefix)` returning pi-tui `AutocompleteItem`
  (`value`, `label`, optional `description`). Prefix `q` → `quota`.
- omp's RPC still advertises `input: {"hint":"arguments"}` for extension commands and drops custom
  `input.hint`; command argument completion still works, because it comes from
  `getArgumentCompletions`.

## 2026-11-21 — Settings layer

`/freepi config` and `/freepi settings` are one handler. Values persist as JSON in
`~/.freepi-plugin/settings.json` (`SETTINGS_PATH`), precedence defaults/env < file.

Keys: `baseUrl`, `port`, `cache.enabled`, `cache.ttlMs`, `cache.maxEntries`, `cache.maxBytes`,
`ads.gravity`, `models.freeOnly`, `models.hidden` (comma list), `models.contextWindow`,
`models.maxTokens`. Actions: `show`, `get`, `set`, `unset`, `reset`, `path`, `help`.
Completion completes actions and keys for `set|get|unset`.

Live application: `cache.*` via `ResponseCache.configure` (mutable limits, trims entries) and
`ads.gravity` via the gravity getter reading `currentSettings`. `baseUrl`, `port`, and
`models.*` metadata are fixed at registration/server bind, so the command says "Restart omp".
`/v1/models` filtering (`freeOnly`, `hidden`) does read live `ctx.settings`.

Gotcha: plugin init loads settings once (`currentSettings`) before `startServer`, so the file
must exist/parse before the first command; mutations clone, save, then `applySettings`.

## 2026-11-21 — Premium model visibility and interactive settings

Premium-gated models are hidden by default (`models.showPremium=false`). `src/visibility.ts` owns the
rule: hide `!free` models when `multiplier >= 1`, plus observed sub-1x outliers in
`PREMIUM_ONLY_IDS` (`mimo-v2.6-flash` and the other 16 probed 403 models). Provider registration and
`/v1/models` both call `isModelVisible`, so defaults expose exactly 10 models: 4 free + 6 that spend
the daily allowance. Set `models.showPremium true` to expose the 403 bucket.

`/freepi config` and `/freepi settings` with no action open an interactive menu built directly on
`ctx.ui.custom` (no pi-tui import, preserving zero dependencies): type to filter, arrows navigate,
Enter toggles booleans or opens `ctx.ui.editor` for numbers/strings/lists, Esc closes. Hosts without
`custom` fall back to the text listing. Explicit `show|get|set|unset|reset|path|help` actions remain
for scripting.

## 2026-11-21 — Removed standalone /freepi-quota

The separate `/freepi-quota` command is gone. Quota lives only under `/freepi quota`; the
`freepi_quota` tool remains for the model.

## 2026-11-24 — Stream-error hang fix (F-1/F-3)

`pipe()` in `src/server.ts` attached `node.on("error", () => controller.abort())` and nothing else,
so when the upstream response socket died after headers were sent, the client response was never
terminated: a hung agent turn with no error. Fix: the handler now also calls `res.destroy()`.
`test/server-stream.test.mjs` reproduces it (mock upstream writes one SSE event then destroys the
socket) and hangs at 4 s without the fix.

Gotcha: the mock upstream must be created inside the test body and `FREEPI_BASE_URL` must be set
before importing `src/config.ts` (it reads env at module load). A top-level upstream server makes
node:test report "Promise resolution is still pending".

## 2026-11-24 — Placeholder apiKey means "use the token file"

opencode's provider config requires a non-empty `apiKey`, so it sends `Bearer freepi`. `bearer()`
now only accepts JWT-shaped credentials (three dot-separated parts) and otherwise falls back to
`loadToken()`; a placeholder never reaches upstream. Verified in `test/server-auth.test.mjs`.

## 2026-11-24 — opencode: hooks never fire on this build

This opencode (2.3.2, Termux native) validates a plugin's default export as `{id, setup|effect}`,
logs `failed to load plugin` if only `server()` is exported, and — once it loads — never invokes
`server()`, `config`, `auth`, or `tool` hooks. `mistral-vibe.ts` documents the same constraint.
Consequences and the adopted shape:

- The loopback server runs as a **runit service**: `$PREFIX/var/service/freepi-loopback/run` →
  `node scripts/serve.mjs`. Without it every `opencode run` fails `ECONNREFUSED` in a retry loop.
- The provider block is **static** in `opencode.jsonc`; regenerate with
  `node scripts/opencode-provider.mjs` after catalog changes (opencode never asks the server).
- Login and quota are **commands** (`/freepi-login`, `/freepi-quota`) backed by the CLI scripts,
  because there is no hook to register tools or oauth through.
- Do not rely on `opencode service restart` to start the plugin server: the module is evaluated in
  short-lived CLI processes, so nothing survives to serve requests.

Gotcha: writing the provider block into `opencode.jsonc` by hand breaks the document easily — the
mistral-vibe object's closing brace is easy to swallow. Validate after editing (parse with comments
stripped) before running opencode, or all providers disappear from `opencode models`.
