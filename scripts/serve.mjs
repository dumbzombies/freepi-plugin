// Standalone loopback server for hosts that cannot keep a plugin process alive
// (opencode starts, uses, then discards plugin modules). Binds the configured
// port and stays up; the opencode provider block points here.
//
//   node scripts/serve.mjs

import { ensureServer } from "../src/runtime.ts";

const running = await ensureServer();
process.stdout.write(`freepi loopback: ${running.url}\n`);

const keepAlive = setInterval(() => {}, 1 << 30);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(keepAlive);
    void running.close().finally(() => process.exit(0));
  });
}
