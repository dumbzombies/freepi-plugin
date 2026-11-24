// Standalone loopback server for hosts that cannot keep a plugin process alive
// (opencode starts, uses, then discards plugin modules).
//
// The opencode provider block pins a fixed baseURL, so this process MUST own
// that exact port: if it silently fell back to port+1, opencode would keep
// talking to whatever else holds the configured port. Fail loudly instead.
//
//   node scripts/serve.mjs

import { defaultSettings } from "../src/settings.ts";
import { ensureServer } from "../src/runtime.ts";

const wanted = defaultSettings().port;
const running = await ensureServer();

if (running.port !== wanted) {
  console.error(
    `freepi loopback: port ${wanted} is taken (bound ${running.port} instead).\n` +
      `Hosts with a fixed baseURL would fail or reach the wrong server.\n` +
      `Free port ${wanted} or change settings.port and regenerate the host config.`,
  );
  await running.close();
  process.exit(1);
}

process.stdout.write(`freepi loopback: ${running.url}\n`);

const keepAlive = setInterval(() => {}, 1 << 30);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(keepAlive);
    void running.close().finally(() => process.exit(0));
  });
}
