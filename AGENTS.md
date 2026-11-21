# freepi-plugin

pi/omp extension that exposes free-pi (freepi.ai) as a native provider. Unofficial; upstream
behavior (catalog, metering, model list) can change.

Before work: read `.agents/state.md`, then `.agents/memory.md`, then this file. Memory-bank rules
live in `.agents/README.md`; run the **sync** skill after a large verified task.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Extension entry: provider, commands, tool, server bootstrap |
| `src/server.ts` | Loopback `node:http` OpenAI-compatible API |
| `src/upstream.ts` | free-pi client: catalog, version/426 gate, `/me`, completions, ads |
| `src/state.ts` | Session id, spent-session retry, stats settle |
| `src/token.ts` | Token load/save, device login |
| `src/cache.ts` | Exact-response LRU with TTL, byte cap, single-flight |
| `src/gravity.ts` | Optional Gravity ad pixel |
| `src/config.ts` | Constants, paths, environment defaults |
| `scripts/probe-*.mjs` | Context-limit and billing probes (spend credits) |
| `test/server.test.mjs` | `node:test` suite |

## Commands

```sh
npm test
node --check src/index.ts
node scripts/probe-context.mjs --help
node scripts/probe-billing.mjs --plan
omp plugin link ~/projects/freepi-plugin
```

## Conventions

- Zero runtime dependencies, ESM, `node:` prefixes. No build step; Node ≥ 22.19 strips types.
- Boring modules; pure modules (cache, config) stay side-effect free.
- State lives in `~/.freepi-plugin` (`FREEPI_PLUGIN_DATA_DIR`). Never write
  `~/.free-pi/agent/credentials.json`.
- Every completion turn runs `/ads/next`, optional Gravity pixel, `/ads/impression`. Never bypass,
  spoof, or hide ad/metering traffic.
- Server binds loopback only; port 8473 with upward probing.
- Upstream errors pass through and are not cached; only spent-session errors retry (once).
