// Gravity pixel + context for legitimate ad attribution (mirrors free-pi-cli's
// src/gravity-pixel.ts and freepi-proxy's src/gravity.ts). Loads
// @gravity-ai/api from the global free-pi-cli install when present; degrades to
// no context. Must never block or crash the plugin.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const GRAVITY_PIXEL_ID = "6cd74804-0541-4d9b-899d-d7fceb465b6f";
export const GRAVITY_CONTEXT_MAX_BYTES = 8192;

/** Candidate global module roots, in priority order. */
function globalModuleRoots(): string[] {
  const roots = new Set<string>();
  const add = (p: string | undefined) => { if (p && p.trim()) roots.add(p.trim()); };
  try {
    const out = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 4_000, stdio: ["ignore", "pipe", "ignore"] });
    add(out);
  } catch { /* npm not on PATH */ }
  try {
    const out = execFileSync("bun", ["pm", "bin", "-g"], { encoding: "utf8", timeout: 4_000, stdio: ["ignore", "pipe", "ignore"] });
    add(out);
  } catch { /* ignore */ }
  for (const p of [
    "/usr/lib/node_modules",
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    join(homedir(), ".bun", "install", "global", "node_modules"),
    join(homedir(), ".npm-global", "lib", "node_modules"),
  ]) add(p);
  return [...roots];
}

interface GravityPixel {
  start(): Promise<void>;
  getSessionId?(): string | undefined;
  getVisitorId?(): string | undefined;
  getClickId?(): string | undefined;
  getGraid?(): string | undefined;
}

interface GravitySdk {
  gravityPixel?: (opts: { pixelId: string; appName: string; storageDir: string }) => GravityPixel;
  gravityContext?: (opts: unknown) => unknown;
}

/** Dynamic import is required: the module path is resolved from env or a
 * global free-pi-cli install at runtime. */
async function loadSdk(): Promise<GravitySdk | null> {
  if (process.env.FREEPI_GRAVITY_SDK) {
    try { return (await import(pathToFileURL(process.env.FREEPI_GRAVITY_SDK).href)) as GravitySdk; } catch { /* fall through */ }
  }
  for (const root of globalModuleRoots()) {
    for (const base of [root, join(root, "free-pi-cli"), join(root, "free-pi-cli", "node_modules")]) {
      try {
        const req = createRequire(join(base, "package.json"));
        const resolved = req.resolve("@gravity-ai/api");
        return (await import(pathToFileURL(resolved).href)) as GravitySdk;
      } catch { /* try next candidate */ }
    }
  }
  try { return (await import("@gravity-ai/api")) as GravitySdk; } catch { return null; }
}

function userIdFromJwt(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch { return undefined; }
}

// The CLI's pixel registers SIGINT/SIGTERM handlers that call process.exit(0).
// Remove those to avoid clobbering the host's shutdown. Keep "exit".
function dropPixelSignalHandlers(): () => void {
  const onNew = (event: string | symbol, fn: unknown) => {
    if ((event !== "SIGINT" && event !== "SIGTERM") || typeof fn !== "function") return;
    if (!/shutdownSync/.test(Function.prototype.toString.call(fn))) return;
    queueMicrotask(() => process.removeListener(event, fn as (...args: unknown[]) => void));
  };
  process.on("newListener", onNew);
  return () => process.removeListener("newListener", onNew);
}

/** Start the pixel lazily and return a getter for the per-turn context. */
export function startGravityPixel(jwt: string): () => string | undefined {
  if (process.env.FREEPI_NO_GRAVITY_PIXEL === "1") return () => undefined;
  const userId = userIdFromJwt(jwt);
  if (!userId) return () => undefined;
  const userHash = createHash("sha256").update(userId).digest("hex");
  const storageDir = join(homedir(), ".free-pi", "gravity");

  let sdk: GravitySdk | null = null;
  let pixel: GravityPixel | undefined;
  void (async () => {
    try {
      sdk = await loadSdk();
      if (!sdk?.gravityPixel || !sdk?.gravityContext) return;
      pixel = sdk.gravityPixel({ pixelId: GRAVITY_PIXEL_ID, appName: "free-pi", storageDir });
      const stopWatching = dropPixelSignalHandlers();
      try { await pixel.start(); } finally { stopWatching(); }
    } catch { pixel = undefined; }
  })();

  return () => {
    try {
      const sessionId = pixel?.getSessionId?.();
      if (!sdk || !pixel || !sessionId) return undefined;
      const ctx = sdk.gravityContext({
        sessionId,
        user: { userId: userHash, gruid: pixel.getVisitorId?.(), grclid: pixel.getClickId?.(), graid: pixel.getGraid?.() },
      });
      const encoded = Buffer.from(JSON.stringify(ctx)).toString("base64url");
      return encoded.length <= GRAVITY_CONTEXT_MAX_BYTES ? encoded : undefined;
    } catch { return undefined; }
  };
}
