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

## 2026-11-24 — Caching: two independent tiers, both measurable

**Response cache** (`src/cache.ts`) is now memory + disk. `CACHE_DIR` defaults to
`~/.freepi-plugin/cache` and is shared by every host, so a turn paid for by omp is served to the
opencode service and entries survive restarts (`x-freepi-cache: hit-disk`). Verified: cold 1.4 s vs
warm 3 ms, and a hit after `sv restart freepi-loopback`.

Key rules that make hits possible — do not "clean these up":

- `normalizeForCache` drops `stream` and `stream_options` unless `stream === true`. Hosts that add
  `"stream": false` or `include_usage` must hash to the same entry, or every host gets its own copy.
- `canonical()` sorts object keys recursively. Field order differs between hosts.
- Do **not** replace `JSON.stringify(canonical(x))` with a hand-built canonical string or with
  per-scalar `hash.update()` calls. Measured on a 170 KiB body: native 0.86 ms, hand-built 1.07 ms,
  per-scalar 1.93 ms. Both "optimizations" were tried and reverted.

Disk-tier gotchas:

- `store()` must `await writeDisk` before the run's `done` settles, or a caller that awaits `done`
  and then reads from another process misses.
- Two servers share the directory. `writeIndex` merges the on-disk index (skipping keys in
  `removed`), and temp files carry `process.pid` so writers never rename over each other.
- Disk entries load as metadata only (`payload: null`); the body is read on first hit.

**Prompt cache** is upstream, not ours: free-pi reports `usage.prompt_tokens_details.cached_tokens`.
`src/telemetry.ts` extracts it from the last `"usage"` object in JSON or SSE and `/healthz`,
`/v1/quota`, `/freepi server`, and `scripts/quota.mjs` all show the ratio. Measured 3840/4034 (95%)
prompt tokens reused on each turn of a 400-message conversation with a stable prefix.

`scripts/quota.mjs` now asks the running service (`/v1/quota`) before falling back to a throwaway
server: only the live process has real counters.

## 2026-11-24 — pi and pi-bolt: two host-API differences

pi-bolt reads `~/.pi/agent/settings.json`, so `pi-bolt install <dir> --approve` covers both `pi` and
`pi-bolt`. Two things broke the extension there and both are fixed in `src/index.ts`:

1. **No `pi.zod`.** omp exposes a schema builder as `pi.zod.object(...)`; pi/pi-bolt expose none —
   their docs import `Type` from `typebox`, which the host maps to its own copy. The tool now uses
   `pi.zod?.object({}) ?? pi.typebox?.Type?.Object?.({}) ?? { type: "object", properties: {} }`.
   Symptom when broken: `Failed to load extension … undefined is not an object (evaluating
   'pi.zod.object')` and no provider at all.
2. **`apiKey` is mandatory.** pi-bolt exits `No API key found for freepi` for a provider config with
   no `apiKey`, even with an `oauth` block. The provider now declares `apiKey: "freepi"`; the
   loopback `bearer()` ignores non-JWT values and falls back to `~/.freepi-plugin/token`, so this is
   a placeholder, not a credential — do not "fix" it by putting a real token there.

Verification that matters: `pi-bolt --list-models | grep freepi` shows all 10 with 200K/32.8K, and
`pi-bolt -p --model freepi/deepseek-v4.1-flash` returns the model's answer. `pi-bolt doctor` reports
the extension as interpreted/loaded; a loaded-but-silent extension means one of the two items above.

## 2026-11-24 — Six cache defects fixed (adversarial pass)

All six came from the disk/in-flight cache added earlier the same day. Each has a regression test.

**F-1 in-flight follower inherited an error body as a hit.** `drain()` settled the shared promise
with a payload before checking `cacheable`, so a concurrent identical request got `hit-memory` with
the leader's 500 and `savedBytes` grew. Fix: return `null` for `!src.cacheable`, so followers
re-fetch. Verified end-to-end: two concurrent posts against a failing upstream → both `500 miss`,
`hits: 0`.

**F-2 concurrent index writers lost entries.** Merge is read-modify-write; a per-instance promise
chain cannot help because omp's in-process server and the opencode service are different processes.
Fix: `withIndexLock()` using `writeFile(..., {flag:"wx"})` on `index.lock`, stale after 5 s.
Measured before: `[false, true, false]`; after: all survive.

**F-3 expired entries leaked bodies.** `loadDisk()` used `continue` for expired metadata. Fix:
`unlink` the orphan. Measured: 6 orphans → 1.

**F-4 stale tombstone deleted another process's fresh entry.** `removed` is per-process but applied
to the shared index. Fix: store eviction *times* and only drop disk copies with `createdAt <=
evictedAt`; clear the map after the index write lands.

**F-5 `removed` grew unbounded.** 5000 stores → 4950 tombstones. After F-4's retirement: 2000
evictions → 1.

**H-1 cache key omitted the credential.** The disk tier made this durable, so account A's paid body
could be replayed to account B. `key(bodyText, scope)` now hashes the scope; completions passes the
JWT. Never embed the token in the key itself — file names are the key.

**H-2 `serve.mjs` silently bound port+1.** opencode pins `http://127.0.0.1:8473/v1`, so a fallback
would leave opencode talking to whatever holds 8473 (proved with a fake "impostor" server). The
script now exits 1 with an actionable message.

Gotcha for future cache work: every one of these was invisible to a *serial* test. If you touch
`run`/`drain`/`writeIndex`, test with two instances and `Promise.all`, and assert on
`stats().hits`/`savedBytes`, not just the body.
