// Process-wide runtime: one loopback server and one settings snapshot, shared by
// the pi/omp extension (src/index.ts) and the standalone server used by
// opencode (scripts/serve.mjs). Whichever host loads first owns the port; a
// second host in the same process reuses it.

import { startGravityPixel } from "./gravity.ts";
import { startServer, type RunningServer } from "./server.ts";
import { loadSettings, type Settings } from "./settings.ts";

let serverPromise: Promise<RunningServer> | null = null;
let currentSettings: Settings | null = null;

export async function effectiveSettings(): Promise<Settings> {
  currentSettings ??= await loadSettings();
  return currentSettings;
}

export function ensureServer(): Promise<RunningServer> {
  if (!serverPromise) {
    serverPromise = effectiveSettings().then((settings) => startServer(settings)).then((running) => {
      let cachedJwt = "";
      let getContext: () => string | undefined = () => undefined;
      running.ctx.gravityContext = (jwt: string) => {
        if (!currentSettings?.ads.gravity) return undefined;
        if (jwt !== cachedJwt) {
          cachedJwt = jwt;
          getContext = startGravityPixel(jwt);
        }
        return getContext();
      };
      return running;
    });
  }
  return serverPromise;
}

/** Apply settings live: cache limits now, port/baseUrl/model on restart. */
export function applySettings(next: Settings): void {
  currentSettings = next;
  void serverPromise?.then((running) => {
    running.ctx.settings = next;
    running.ctx.cache.configure(next.cache);
  });
}
