// Print the free-pi quota for the logged-in account. Used by the opencode
// `/freepi-quota` command (and usable from any shell).
//
//   node scripts/quota.mjs

import { loadToken } from "../src/token.ts";
import { quotaView } from "../src/state.ts";
import { renderQuota } from "../src/format.ts";
import { ensureServer } from "../src/runtime.ts";

const token = await loadToken();
if (!token) {
  console.error("Not logged in to free-pi. Run: node scripts/login.mjs");
  process.exit(1);
}

const running = await ensureServer();
try {
  process.stdout.write(renderQuota(await quotaView(running.ctx, token)) + "\n");
} finally {
  await running.close();
}
