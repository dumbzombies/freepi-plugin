// freepi-plugin — a pi/omp extension that adds free-pi as a first-class
// provider: `/login freepi` runs the CLI's GitHub device flow, `/freepi` shows
// quota, and every completion goes through an in-process OpenAI-compatible
// server that preserves free-pi's ad cycle, session rotation and caching.

import { startServer, type RunningServer } from "./server.ts";
import { deviceLogin, loadToken, tokenExpiry } from "./token.ts";
import { quotaView, type QuotaView } from "./state.ts";
import { startGravityPixel } from "./gravity.ts";
import type { Catalog, CatalogModel } from "./upstream.ts";

// ---------- host API subset (pi and omp are structurally compatible) ----------

interface Ui {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface CommandCtx {
  ui: Ui;
}

interface OAuthDeviceInfo {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

interface OAuthCallbacks {
  /** Legacy device-code hook (older pi/omp extension host). */
  onDeviceCode?(info: OAuthDeviceInfo): void;
  /** Canonical hook: show a URL (and optional instructions) to the user. */
  onAuth?(info: { url: string; instructions?: string }): void;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}

interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: { supportsDeveloperRole?: boolean };
}

interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  models?: ProviderModel[];
  oauth?: {
    name: string;
    login(callbacks: OAuthCallbacks): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
  };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

interface PiApi {
  registerProvider(name: string, config: ProviderConfig): void;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: CommandCtx) => unknown }): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(...args: unknown[]): Promise<ToolResult>;
  }): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  /** Zod-compatible schema builder used for tool parameters. */
  zod: { object(shape: Record<string, unknown>): unknown };
}

// ---------- constants ----------

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// free-pi-cli 0.6.25 declares these for every catalog model (src/provider.ts):
// CONTEXT_WINDOW = 200000, MAX_OUTPUT_TOKENS = 32768, reasoning: true.
const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 32_768;
const MODEL_COMPAT = { supportsDeveloperRole: false };

/** Last-resort list when the public catalog cannot be fetched at load time. */
const FALLBACK_MODELS: ProviderModel[] = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
  { id: "particle", name: "Particle" },
].map((m) => ({
  ...m,
  reasoning: true,
  input: ["text"],
  cost: ZERO_COST,
  contextWindow: CONTEXT_WINDOW,
  maxTokens: MAX_TOKENS,
  compat: MODEL_COMPAT,
}));

function toProviderModel(m: CatalogModel): ProviderModel {
  return {
    id: m.id,
    name: (m.display_name || m.name.split(" · ")[0]?.trim() || m.id) + (m.free ? " (free)" : ""),
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    compat: MODEL_COMPAT,
  };
}

function providerModels(catalog: Catalog | null): ProviderModel[] {
  const available = (catalog?.models ?? []).filter((m) => !m.unavailable);
  return available.length > 0 ? available.map(toProviderModel) : FALLBACK_MODELS;
}

// ---------- process-wide server ----------

let serverPromise: Promise<RunningServer> | null = null;

function ensureServer(): Promise<RunningServer> {
  if (!serverPromise) {
    serverPromise = startServer().then((running) => {
      let cachedJwt = "";
      let getContext: () => string | undefined = () => undefined;
      running.ctx.gravityContext = (jwt: string) => {
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

// ---------- quota rendering ----------

function formatCredits(n: number | null): string {
  if (n == null) return "?";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "unknown";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

function renderQuota(view: QuotaView, fallbackHandle?: string): string {
  const handle = view.handle ?? fallbackHandle;
  const head = ["free-pi", handle ? `@${handle}` : null, view.tier].filter(Boolean).join(" · ");
  if (!view.ok) {
    return `${head}\nQuota unavailable: ${view.error ?? "no stats returned"}. Check your connection and try /freepi again.`;
  }
  const q = view.quota;
  const lines = [
    head,
    `Credits: ${formatCredits(q.remaining_credits_today)} / ${formatCredits(q.allowance_credits)} left (${q.remaining_pct ?? "?"}%)`,
    `Used today: ${formatCredits(q.used_credits_today)} credits · $${q.spent_usd_today ?? "?"} of $${q.cap_usd_today ?? "?"}`,
    `Requests today: ${view.usage.requests_today ?? "?"} · tokens ${view.usage.prompt_tokens_today ?? "?"} in / ${view.usage.completion_tokens_today ?? "?"} out`,
    `Refills in ${formatDuration(q.refill_in_ms)}${q.refill_at ? ` (${q.refill_at})` : ""}`,
  ];
  if (view.notice) lines.push(`Notice: ${view.notice}`);
  if (view.usage.streak_days != null) lines.push(`Streak: ${view.usage.streak_days} day(s)`);
  return lines.join("\n");
}

// ---------- extension ----------

export default async function freepiPlugin(pi: PiApi): Promise<void> {
  const running = await ensureServer();
  await running.ctx.upstream.refreshCatalog();

  pi.registerProvider("freepi", {
    name: "Free Pi",
    baseUrl: running.url,
    api: "openai-completions",
    models: providerModels(running.ctx.upstream.catalog),
    oauth: {
      name: "Free Pi (GitHub)",
      async login(callbacks: OAuthCallbacks): Promise<OAuthCredentials> {
        const debug = (msg: string) => { if (process.env.FREEPI_PLUGIN_DEBUG === "1") console.error(`[freepi-plugin] ${msg}`); };
        debug("oauth login started");
        let handle: string | null = null;
        const token = await deviceLogin({
          onDeviceCode: (info) => {
            debug(`device code ${info.userCode} at ${info.verificationUri}`);
            if (callbacks.onDeviceCode) {
              callbacks.onDeviceCode(info);
              return;
            }
            // Canonical hosts expose onAuth instead of onDeviceCode.
            const url = info.userCode
              ? `${info.verificationUri}?user_code=${encodeURIComponent(info.userCode)}`
              : info.verificationUri;
            callbacks.onAuth?.({ url, instructions: `GitHub device code: ${info.userCode}` });
          },
          onProgress: (msg) => callbacks.onProgress?.(msg),
          signal: callbacks.signal,
        });
        // Record the handle for nicer quota output; never fail login over it.
        try {
          const me = await running.ctx.upstream.me(token);
          handle = me?.handle ?? null;
        } catch { /* ignore */ }
        return {
          refresh: token,
          access: token,
          expires: tokenExpiry(token) ?? Date.now() + 30 * 24 * 3_600_000,
          ...(handle ? { handle } : {}),
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const expires = tokenExpiry(credentials.access);
        if (expires != null && expires <= Date.now() + 60_000) {
          throw new Error("free-pi token expired — run /login freepi again");
        }
        return { ...credentials, expires: expires ?? Date.now() + 30 * 24 * 3_600_000 };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    },
  });

  const quota = async (args: string, ctx: CommandCtx): Promise<void> => {
    const token = await loadToken();
    if (!token) {
      ctx.ui.notify("free-pi: not logged in. Run /login freepi (or `omp login freepi`).", "warning");
      return;
    }
    const view = await quotaView(running.ctx, token);
    ctx.ui.notify(renderQuota(view), view.ok ? "info" : "warning");
  };

  pi.registerCommand("freepi", {
    description: "Show free-pi quota, account, and plugin status",
    handler: async (args: string, ctx: CommandCtx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "models") {
        const models = providerModels(running.ctx.upstream.catalog);
        const catalog = running.ctx.upstream.catalog;
        const detail = models.slice(0, 40).map((m) => {
          const raw = catalog?.models.find((c) => c.id === m.id);
          return `${m.id}${raw && !raw.free ? ` (${raw.multiplier}x)` : raw?.free ? " (free)" : ""}`;
        });
        ctx.ui.notify(`free-pi models: ${models.length}\n${detail.join("\n")}`, "info");
        return;
      }
      if (sub === "login") {
        ctx.ui.notify("Run /login freepi (or `omp login freepi`) to sign in with GitHub.", "info");
        return;
      }
      if (sub === "server") {
        ctx.ui.notify(`free-pi server: ${running.url}\ngravity ads: pending SDK\nlogin token file: managed by plugin`, "info");
        return;
      }
      await quota(args, ctx);
    },
  });

  pi.registerCommand("freepi-quota", {
    description: "Show the free-pi daily credit quota",
    handler: quota,
  });

  pi.registerTool({
    name: "freepi_quota",
    label: "Free Pi quota",
    description: "Show the current free-pi account's daily credit quota, usage, and refill time.",
    parameters: pi.zod.object({}),
    async execute(): Promise<ToolResult> {
      const token = await loadToken();
      if (!token) {
        return { content: [{ type: "text", text: "Not logged in to free-pi. Run /login freepi." }] };
      }
      const view = await quotaView(running.ctx, token);
      return { content: [{ type: "text", text: renderQuota(view) }] };
    },
  });

  pi.on("session_start", async (...args: unknown[]) => {
    const ctx = args[1] as CommandCtx | undefined;
    const token = await loadToken();
    if (!token) {
      ctx?.ui.notify("free-pi: run /login freepi to use free models.", "info");
    }
  });
}
