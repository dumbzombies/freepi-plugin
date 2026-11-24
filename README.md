# freepi-plugin

**free-pi as a pi/omp provider: `/login freepi`, quota, ads, and a self-contained OpenAI-compatible API — zero dependencies.**

Unofficial. Not affiliated with free-pi / freepi.ai. It speaks the same backend as `free-pi-cli`; upstream behavior can change.

## Why

`freepi-proxy` runs a separate gateway. This fork embeds the same core in the plugin process, so pi/omp can:

- add free-pi via `/login freepi` (GitHub device flow, same endpoints as the CLI)
- select free-pi models directly as `freepi/<model>`
- check today's credits with `/freepi` or the `freepi_quota` tool
- keep the ad cycle, session rotation, force-upgrade gate, and exact-response cache intact

Model metadata mirrors `free-pi-cli` 0.6.25: every catalog model is registered with a 200,000-token
context window, 32,768 max output tokens, thinking enabled, and `supportsDeveloperRole: false`.
The plugin does not invent per-model limits from other catalogs.

There is no dashboard, MCP server, or Anthropic bridge. The plugin starts an in-process loopback server
(`127.0.0.1`, port 8473+) that implements `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/quota`,
and `GET /healthz`; the provider points at it.

## Install

Zero dependencies, no build step. Requires Node ≥ 22.19 (for TypeScript type stripping).

### pi

```sh
pi install git:github.com/dumbzombies/freepi-plugin    # or ./path/to/freepi-plugin
pi list                                               # confirm it is registered
```

### omp

```sh
omp plugin link ./freepi-plugin          # from a checkout
omp plugin install freepi-plugin         # or from the marketplace entry
omp plugin doctor                        # expect plugin:freepi-plugin: 0 errors
```

### pi-bolt

pi-bolt reads `~/.pi/agent/settings.json`, so this install also covers `pi`:

```sh
pi-bolt install /path/to/freepi-plugin --approve
pi-bolt list                             # ../../projects/freepi-plugin
pi-bolt --list-models | grep freepi      # 10 models
pi-bolt -p --model freepi/deepseek-v4.1-flash "hi"
```

The extension depends on two host details that differ between omp and pi-bolt: omp exposes a
`schema` builder as `pi.zod`, pi-bolt has none (it maps `typebox` imports instead), and pi-bolt
refuses to run a provider declared without an `apiKey`. The plugin handles both — tool schemas fall
back to a plain JSON-schema object and the provider declares a placeholder `apiKey` that the loopback
server treats as "use the token file" rather than as a credential.

### opencode

opencode's plugin hooks are not invoked by the current build, so this host uses a static provider
block plus a long-running loopback server:

```sh
# 1. provider block (regenerate after a free-pi catalog change)
node scripts/opencode-provider.mjs > /tmp/freepi-provider.json
#    paste the object into ~/.config/opencode/opencode.jsonc under provider.freepi

# 2. keep the loopback server up
node scripts/serve.mjs                    # foreground
# or as a runit service:
mkdir -p "$PREFIX/var/service/freepi-loopback"
printf '#!/data/data/com.termux/files/usr/bin/sh\ncd %s || exit 1\nexec node scripts/serve.mjs 2>&1\n' \
  "$PWD" > "$PREFIX/var/service/freepi-loopback/run"
chmod +x "$PREFIX/var/service/freepi-loopback/run"
sv-enable freepi-loopback && sv status freepi-loopback
```

Then `opencode models` lists `freepi/<model>`, and `/freepi-login` / `/freepi-quota` come from
`~/.config/opencode/command/freepi-{login,quota}.md`:

```md
---
description: Show the Free Pi quota, usage, and refill time
---

!`node "$HOME/projects/freepi-plugin/scripts/quota.mjs"`
```

Restart the agent after linking.

### Login

`/login freepi` (pi/omp) or `node scripts/login.mjs` (any host) runs the GitHub device flow and
writes `~/.freepi-plugin/token`; all three hosts share that file.

## Use

```
/login freepi          # GitHub device code; prints the code and URL
/model freepi/...      # pick a free-pi model
/freepi                # status: server, models, login, handle/tier, quota line
/freepi quota          # full quota: credits left, used, refill, streak
/freepi models         # registered model list (premium-only models hidden)
/freepi config         # show every setting
/freepi settings       # same as /freepi config
```

`omp login freepi` works outside a session. The plugin stores its own token copy in
`~/.freepi-plugin/token` (mode 0600) for the quota command; it never touches the free-pi CLI credentials file.

## Configuration

`/freepi config` and `/freepi settings` are the same command. With no arguments it opens an
interactive menu: type to filter, `↑`/`↓` move, `Enter` edits or toggles, `Esc` closes.

```
/freepi config                      # interactive settings menu
/freepi config get <key>
/freepi config set <key> <value>    # persisted to ~/.freepi-plugin/settings.json
/freepi config unset <key>          # back to its default
/freepi config reset                # delete the file and reload defaults
/freepi config path
```

Settings override environment defaults. `cache.*` and `ads.gravity` apply immediately;
`baseUrl`, `port`, and `models.*` take effect on the next host start.

|Key|Default|Meaning|
|---|---|---|
|`baseUrl`|`https://api.freepi.ai`|Upstream base URL|
|`port`|`8473`|Preferred loopback port; probes upward|
|`cache.enabled`|`true`|Exact-response cache (memory + disk)|
|`cache.ttlMs`|`86400000`|Cache entry lifetime (24 h)|
|`cache.maxEntries`|`300`|Cached response count cap|
|`cache.maxBytes`|`33554432`|Cached response byte cap|
|`ads.gravity`|`true`|Attach Gravity ad context when the SDK exists|
|`models.freeOnly`|`false`|Expose only catalog models marked free|
|`models.showPremium`|`false`|Show models that 403 without purchased premium credits|
|`models.hidden`|empty|Comma-separated model ids to hide|
|`models.contextWindow`|`200000`|Advertised context window|
|`models.maxTokens`|`32768`|Advertised max output tokens|

Environment variables below seed those defaults:

|Variable|Default|Meaning|
|---|---|---|
|`FREEPI_PLUGIN_PORT`|`8473`|First loopback port tried; the next 19 are probed|
|`FREEPI_PLUGIN_DATA_DIR`|`~/.freepi-plugin`|Token, stable session id, learned client version|
|`FREEPI_CACHE`|`1`|`0` disables the exact-response cache|
|`FREEPI_CACHE_DIR`|`~/.freepi-plugin/cache`|Disk tier shared by every host; `off` keeps memory only|
|`FREEPI_CACHE_TTL_MS`|`3600000`|Cache entry lifetime|
|`FREEPI_BASE_URL`|`https://api.freepi.ai`|Upstream base (dev/testing)|
|`FREEPI_NO_GRAVITY_PIXEL`|unset|`1` skips the optional Gravity attribution pixel|

## Caching

Two independent caches, both measurable:

**Response cache (local).** Byte-identical requests return the stored body without contacting
free-pi — no credits spent. Keys ignore field order, whitespace, and `stream: false` /
`stream_options`, so the same conversation hashes identically regardless of which host serialized it.
The in-memory LRU and an on-disk tier in `~/.freepi-plugin/cache` are both shared: a turn paid for by
omp is served to opencode, and entries survive restarts. Concurrent writers merge the index instead
of overwriting each other.

```sh
curl -s 127.0.0.1:8473/healthz | jq .cache     # hits, misses, savedBytes, hitRate
```

Measured: ~1.4 s cold, ~3 ms warm.

**Prompt cache (upstream).** free-pi reuses a stable prompt prefix and reports it as
`usage.prompt_tokens_details.cached_tokens`. The plugin accumulates that ratio, so you can see
whether a conversation is actually reusing prefix instead of re-billing it. Keeping the leading
messages of a conversation byte-identical is what makes this hit; changing the system prompt or
inserting a timestamp at the top of the context defeats it.

```sh
curl -s 127.0.0.1:8473/healthz | jq .promptCache
```

A 400-message conversation measured 3840 of 4034 prompt tokens served from the upstream cache (95%)
on every turn once the prefix was stable.

Effects on the response cache: disabled with `FREEPI_CACHE=0`; disk tier off with
`FREEPI_CACHE_DIR=off`.

## Safety notes

- The server binds loopback only. It has no bearer gate of its own; the provider sends the free-pi JWT,
  and requests without one fall back to the plugin token file.
- Ad and impression reporting is never bypassed or spoofed; the ad cycle runs for every upstream turn,
  exactly as in `freepi-proxy`.
- Errors pass through unchanged. Spent-session retries happen once, on a fresh session id.

## Context and free/paid probes

`scripts/probe-context.mjs` measures a model's real context window by sending
fresh, metered, ad-attributed turns at increasing prompt sizes. It never asks
for more than one output token.

```sh
node scripts/probe-context.mjs                                  # plan + catalog
node scripts/probe-context.mjs --model deepseek-v4.1-flash --at 200000
node scripts/probe-context.mjs --model deepseek-v4.1-flash --bisect 180000 300000
node scripts/probe-context.mjs --all --at 210000 --budget 6000
```

Each request costs roughly `prompt_tokens * multiplier * 0.00222` credits.
`--budget` stops before crossing the estimate. Results also land in
`~/.freepi-plugin/context-probe.json`.

`scripts/probe-billing.mjs` sends one small ad-attributed turn per model and
polls `/me/stats` for the credit delta:

```sh
node scripts/probe-billing.mjs --plan
node scripts/probe-billing.mjs --model gpt-oss-20b --tokens 1500
node scripts/probe-billing.mjs --models hy4-flash,ling-3.0-flash --tokens 1500
node scripts/probe-billing.mjs --all --tokens 1500 --budget 3000
```

It reuses one upstream session; if the account already has 4 live CLI
sessions, free the slots with `POST /session/reset` or wait for leases to
expire. Results land in `~/.freepi-plugin/billing-probe.json`.

Observed on 2026-11-21:

- no quota hit (catalog `free: true`): `particle`, `deepseek-v4.1-flash`,
  `glm-5.3-flash`, `deepseek-v4-flash`
- charged against the daily allowance: `gpt-oss-20b`, `hy4-flash`,
  `ling-3.0-flash`, `ling-3.1-flash`, `qwen3.7-flash`, `solar-mini-4`
- rejected with `model_requires_credits` without purchased premium credits:
  every other catalog model (all 1.6x and above, plus `mimo-v2.6-flash`)

`/freepi models` marks catalog models free or shows their usage multiplier.

## Tests

```sh
npm test    # node --test, no credentials needed, no credits spent
```

## License

MIT. Derived from `freepi-proxy`.
