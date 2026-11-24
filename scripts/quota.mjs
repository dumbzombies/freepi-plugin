// Print the free-pi quota for the logged-in account. Used by the opencode
// `/freepi-quota` command (and usable from any shell).
//
//   node scripts/quota.mjs
//
// Prefers the running loopback service, which is the only process that has real
// cache counters; without it, a throwaway server answers the same question.

import { loadToken } from "../src/token.ts";
import { quotaView } from "../src/state.ts";
import { renderQuota } from "../src/format.ts";
import { ensureServer } from "../src/runtime.ts";
import { defaultSettings } from "../src/settings.ts";

const token = await loadToken();
if (!token) {
  console.error("Not logged in to free-pi. Run: node scripts/login.mjs");
  process.exit(1);
}

/** Ask an already-running plugin server, if one holds the port range. */
async function fromService() {
  const { port: base } = defaultSettings();
  for (let port = base; port < base + 20; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/quota`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return await res.json();
    } catch {
      continue;
    }
  }
  return null;
}

const view = await fromService().then(async (live) => {
  if (live) return live;
  const running = await ensureServer();
  try {
    return await quotaView(running.ctx, token);
  } finally {
    await running.close();
  }
});

process.stdout.write(renderQuota(view) + "\n");
