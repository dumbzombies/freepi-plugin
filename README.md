# freepi-plugin

**free-pi as a pi/omp provider: `/login freepi`, quota, ads, and a self-contained OpenAI-compatible API — zero dependencies.**

Unofficial. Not affiliated with free-pi / freepi.ai. It speaks the same backend as `free-pi-cli`; upstream behavior can change.

## Why

`freepi-proxy` runs a separate gateway. This fork embeds the same core in the plugin process, so pi/omp can:

- add free-pi via `/login freepi` (GitHub device flow, same endpoints as the CLI)
- select free-pi models directly as `freepi/<model>`
- check today's credits with `/freepi` or the `freepi_quota` tool
- keep the ad cycle, session rotation, force-upgrade gate, and exact-response cache intact

There is no dashboard, MCP server, or Anthropic bridge. The plugin starts an in-process loopback server
(`127.0.0.1`, port 8473+) that implements `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/quota`,
and `GET /healthz`; the provider points at it.

## Install

```sh
# from a checkout
omp plugin link ~/projects/freepi-plugin        # omp
# or add the directory to config.yml: extensions: [~/projects/freepi-plugin]
```

For `pi`, install the same directory as an extension package (its `package.json` carries both
`omp.extensions` and `pi.extensions`). Restart the agent after linking.

## Use

```
/login freepi          # GitHub device code; prints the code and URL
/model freepi/...      # pick a free-pi model
/freepi                # quota: credits left, used, refill, streak
/freepi models         # registered model list
/freepi-quota          # alias for the quota view
```

`omp login freepi` works outside a session. The plugin stores its own token copy in
`~/.freepi-plugin/token` (mode 0600) for the quota command; it never touches the free-pi CLI credentials file.

## Configuration

|Variable|Default|Meaning|
|---|---|---|
|`FREEPI_PLUGIN_PORT`|`8473`|First loopback port tried; the next 19 are probed|
|`FREEPI_PLUGIN_DATA_DIR`|`~/.freepi-plugin`|Token, stable session id, learned client version|
|`FREEPI_CACHE`|`1`|`0` disables the exact-response cache|
|`FREEPI_CACHE_TTL_MS`|`3600000`|Cache entry lifetime|
|`FREEPI_BASE_URL`|`https://api.freepi.ai`|Upstream base (dev/testing)|
|`FREEPI_NO_GRAVITY_PIXEL`|unset|`1` skips the optional Gravity attribution pixel|

## Safety notes

- The server binds loopback only. It has no bearer gate of its own; the provider sends the free-pi JWT,
  and requests without one fall back to the plugin token file.
- Ad and impression reporting is never bypassed or spoofed; the ad cycle runs for every upstream turn,
  exactly as in `freepi-proxy`.
- Errors pass through unchanged. Spent-session retries happen once, on a fresh session id.

## Tests

```sh
npm test    # node --test, no credentials needed, no credits spent
```

## License

MIT. Derived from `freepi-proxy`.
