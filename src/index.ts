// freepi-plugin — a pi/omp extension that adds free-pi as a first-class
// provider: `/login freepi` runs the CLI's GitHub device flow, `/freepi` shows
// quota, and every completion goes through an in-process OpenAI-compatible
// server that preserves free-pi's ad cycle, session rotation and caching.

import { deviceLogin, loadToken, tokenExpiry } from "./token.ts";
import { quotaView } from "./state.ts";
import { formatCredits, formatDuration, renderQuota } from "./format.ts";
import { applySettings, effectiveSettings, ensureServer } from "./runtime.ts";
import type { Catalog } from "./upstream.ts";
import { providerModels } from "./models.ts";
import {
  SETTINGS_PATH,
  SETTING_KEYS,
  defaultSettings,
  findKey,
  formatSettings,
  formatValue,
  resetSettings,
  saveSettings,
  setSetting,
  type Settings,
} from "./settings.ts";

// ---------- host API subset (pi and omp are structurally compatible) ----------

interface Ui {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Host custom component; absent in non-interactive RPC hosts. */
  custom?<T>(factory: (tui: { requestRender(): void }, theme: {
    fg?(color: string, text: string): string;
    bold?(text: string): string;
  }, keybindings: unknown, done: (result: T) => void) => {
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate?(): void;
    dispose?(): void;
  }): Promise<T>;
  editor?(title: string, prefill?: string): Promise<string | undefined>;
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

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

interface PiApi {
  registerProvider(name: string, config: ProviderConfig): void;
  registerCommand(name: string, options: {
    description?: string;
    input?: { hint?: string };
    getArgumentCompletions?(prefix: string): CompletionItem[] | null | Promise<CompletionItem[] | null>;
    handler: (args: string, ctx: CommandCtx) => unknown;
  }): void;
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
// Both are overridable through settings (restart required).
const MODEL_COMPAT = { supportsDeveloperRole: false };

function hostModels(catalog: Catalog | null, settings: Settings): ProviderModel[] {
  return providerModels(catalog, settings).map((m): ProviderModel => ({
    id: m.id,
    name: m.name,
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: MODEL_COMPAT,
  }));
}

// ---------- extension ----------

export default async function freepiPlugin(pi: PiApi): Promise<void> {
  const running = await ensureServer();
  const settings = await effectiveSettings();
  await running.ctx.upstream.refreshCatalog();

  pi.registerProvider("freepi", {
    name: "Free Pi",
    baseUrl: running.url,
    api: "openai-completions",
    models: hostModels(running.ctx.upstream.catalog, settings),
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

  const quota = async (ctx: CommandCtx): Promise<void> => {
    const token = await loadToken();
    if (!token) {
      ctx.ui.notify("free-pi: not logged in. Run /login freepi (or `omp login freepi`).", "warning");
      return;
    }
    const view = await quotaView(running.ctx, token);
    ctx.ui.notify(renderQuota(view), view.ok ? "info" : "warning");
  };

  /** One-screen account/plugin status. Quota detail lives in /freepi quota. */
  const status = async (ctx: CommandCtx): Promise<void> => {
    const token = await loadToken();
    const catalog = running.ctx.upstream.catalog;
    const active = await effectiveSettings();
    const models = hostModels(catalog, active);
    const free = (catalog?.models ?? []).filter((m) => m.free && !m.unavailable).length;
    const lines = [`free-pi server: ${running.url}`, `Models: ${models.length} (${free} free)`];
    if (!token) {
      lines.push("Login: missing — run /login freepi or `omp login freepi`.");
      ctx.ui.notify(lines.join("\n"), "warning");
      return;
    }
    const view = await quotaView(running.ctx, token);
    const head = ["Login: ok", view.handle ? `@${view.handle}` : null, view.tier].filter(Boolean).join(" · ");
    lines.push(head);
    if (view.ok) {
      lines.push(`Quota: ${formatCredits(view.quota.remaining_credits_today)} / ${formatCredits(view.quota.allowance_credits)} credits left (${view.quota.remaining_pct ?? "?"}%) · refills in ${formatDuration(view.quota.refill_in_ms)}`);
    } else {
      lines.push(`Quota: unavailable (${view.error ?? "no stats"})`);
    }
    lines.push("Use /freepi quota for full usage, /freepi models for the model list.");
    ctx.ui.notify(lines.join("\n"), view.ok ? "info" : "warning");
  };

  const modelList = async (ctx: CommandCtx): Promise<void> => {
    const active = await effectiveSettings();
    const catalog = running.ctx.upstream.catalog;
    const models = hostModels(catalog, active);
    const detail = models.slice(0, 40).map((m) => {
      const raw = catalog?.models.find((c) => c.id === m.id);
      return `${m.id}${raw && !raw.free ? ` (${raw.multiplier}x)` : raw?.free ? " (free)" : ""}`;
    });
    ctx.ui.notify(`free-pi models: ${models.length}\n${detail.join("\n")}`, "info");
  };

  const configActions: CompletionItem[] = [
    { value: "show", label: "show", description: "Print every setting and its effective value" },
    { value: "get", label: "get", description: "Print one setting" },
    { value: "set", label: "set", description: "Change one setting and persist it" },
    { value: "unset", label: "unset", description: "Reset one setting to its default" },
    { value: "reset", label: "reset", description: "Delete settings.json and restore defaults" },
    { value: "path", label: "path", description: "Print the settings file path" },
    { value: "help", label: "help", description: "Show config usage" },
  ];

  const configCompletions = (prefix: string): CompletionItem[] => {
    const text = prefix.trim();
    const act = /^(set|get|unset)\s+(\S*)$/i.exec(text);
    if (act) {
      const q = act[2].toLowerCase();
      return SETTING_KEYS.filter((k) => k.path.startsWith(q)).map((k) => ({
        value: `${act[1]} ${k.path}`,
        label: k.path,
        description: k.description,
      }));
    }
    if (text.includes(" ")) return [];
    return configActions.filter((a) => a.value.startsWith(text.toLowerCase()));
  };

  const selectSetting = async (ctx: CommandCtx): Promise<string | null> => {
    if (!ctx.ui.custom) return null;
    return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const fg = (color: string, text: string) => theme.fg ? theme.fg(color, text) : text;
      const bold = (text: string) => theme.bold ? theme.bold(text) : text;
      let cursor = 0;
      let query = "";
      let cached: string[] | undefined;
      const visible = () => {
        const q = query.trim().toLowerCase();
        if (!q) return SETTING_KEYS;
        return SETTING_KEYS.filter((k) => `${k.path} ${k.description}`.toLowerCase().includes(q));
      };
      const refresh = () => {
        cached = undefined;
        tui.requestRender();
      };
      return {
        render(width: number) {
          const w = Math.max(20, width);
          if (cached) return cached;
          const items = visible();
          if (items.length === 0) cursor = 0;
          else if (cursor >= items.length) cursor = items.length - 1;
          const cut = (line: string) => line.length > w ? line.slice(0, w - 1) + "…" : line;
          const lines = [cut(fg("accent", "─".repeat(w))), cut(` ${fg("accent", bold("free-pi settings"))}`)];
          lines.push(cut(` ${fg("text", `Search: ${query || "-"}`)}`), "");
          if (items.length === 0) {
            lines.push(cut(fg("warning", " No matches.")));
          } else {
            const max = 14;
            const start = Math.max(0, Math.min(cursor - Math.floor(max / 2), Math.max(0, items.length - max)));
            const end = Math.min(items.length, start + max);
            for (let i = start; i < end; i++) {
              const key = items[i];
              const active = i === cursor;
              const value = formatValue(key, currentSettings ?? defaultSettings());
              const suffix = key.restart ? fg("dim", "  (restart)") : "";
              const prefix = active ? fg("accent", "> ") : "  ";
              const label = active ? fg("accent", key.path) : fg("text", key.path);
              lines.push(cut(`${prefix}${label} = ${value}${suffix}`));
              if (active) lines.push(cut(`   ${fg("muted", key.description)}`));
            }
          }
          lines.push("", cut(fg("dim", " type to filter • ↑↓ move • enter edit/toggle • esc done")), cut(fg("accent", "─".repeat(w))));
          cached = lines;
          return lines;
        },
        invalidate() { cached = undefined; },
        handleInput(data: string) {
          const items = visible();
          if (data === "\u001b[A" || data === "\u001bOA") {
            if (items.length) cursor = cursor === 0 ? items.length - 1 : cursor - 1;
            refresh();
            return;
          }
          if (data === "\u001b[B" || data === "\u001bOB") {
            if (items.length) cursor = cursor === items.length - 1 ? 0 : cursor + 1;
            refresh();
            return;
          }
          if (data === "\r" || data === "\n") {
            done(items[cursor]?.path ?? null);
            return;
          }
          if (data === "\u001b" || data === "\u0003") {
            done(null);
            return;
          }
          if (data === "\u007f" || data === "\b") {
            if (query) { query = query.slice(0, -1); cursor = 0; refresh(); }
            return;
          }
          if (data >= " " && !data.startsWith("\u001b")) {
            query += data;
            cursor = 0;
            refresh();
          }
        },
      };
    });
  };

  const editSetting = async (ctx: CommandCtx, path: string): Promise<void> => {
    const key = findKey(path);
    if (!key) return;
    if (key.type === "boolean") {
      const next = structuredClone(await effectiveSettings());
      try {
        key.set(next, String(!(key.get(next) as boolean)));
      } catch (e) {
        ctx.ui.notify(`free-pi config: ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }
      await saveSettings(next);
      applySettings(next);
      ctx.ui.notify(`${key.path} = ${formatValue(key, next)}${key.restart ? " Restart omp to apply." : ""}`, "info");
      return;
    }
    if (!ctx.ui.editor) {
      ctx.ui.notify(`Edit without a UI: /freepi config set ${key.path} <value>`, "info");
      return;
    }
    const raw = await ctx.ui.editor(`${key.path} — ${key.description}`, formatValue(key, await effectiveSettings()));
    if (raw === undefined) return;
    const next = structuredClone(await effectiveSettings());
    try {
      setSetting(next, key.path, raw);
    } catch (e) {
      ctx.ui.notify(`free-pi config: ${e instanceof Error ? e.message : String(e)}`, "error");
      return;
    }
    await saveSettings(next);
    applySettings(next);
    ctx.ui.notify(`${key.path} = ${formatValue(key, next)}${key.restart ? " Restart omp to apply." : ""}`, "info");
  };

  const settingsMenu = async (ctx: CommandCtx): Promise<void> => {
    if (!ctx.ui.custom) {
      ctx.ui.notify(formatSettings(await effectiveSettings()), "info");
      return;
    }
    for (;;) {
      const path = await selectSetting(ctx);
      if (!path) return;
      await editSetting(ctx, path);
    }
  };

  const config = async (args: string, ctx: CommandCtx): Promise<void> => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      await settingsMenu(ctx);
      return;
    }
    const action = (parts[0] ?? "show").toLowerCase();
    if (action === "show") {
      ctx.ui.notify(formatSettings(await effectiveSettings()), "info");
      return;
    }
    if (action === "path") {
      ctx.ui.notify(SETTINGS_PATH, "info");
      return;
    }
    if (action === "help") {
      ctx.ui.notify(
        [
          "Usage: /freepi config [show|get|set|unset|reset|path|help]",
          "  set <key> <value>   persist a value (live keys apply now)",
          "  unset <key>         restore the default for one key",
          "  reset               delete settings.json and reload defaults",
          `Keys: ${SETTING_KEYS.map((k) => k.path).join(", ")}`,
        ].join("\n"),
        "info",
      );
      return;
    }
    if (action === "reset") {
      const next = await resetSettings();
      applySettings(next);
      ctx.ui.notify("free-pi settings reset to defaults. Restart omp for port/baseUrl/model changes.", "info");
      return;
    }
    if (action === "get") {
      const key = findKey(parts[1] ?? "");
      if (!key) {
        ctx.ui.notify(`Unknown setting "${parts[1] ?? ""}". Run /freepi config help for keys.`, "error");
        return;
      }
      ctx.ui.notify(`${key.path} = ${formatValue(key, await effectiveSettings())}`, "info");
      return;
    }
    if (action === "set" || action === "unset") {
      const key = findKey(parts[1] ?? "");
      if (!key) {
        ctx.ui.notify(`Unknown setting "${parts[1] ?? ""}". Run /freepi config help for keys.`, "error");
        return;
      }
      const raw = action === "unset"
        ? (Array.isArray(key.get(defaultSettings())) ? (key.get(defaultSettings()) as string[]).join(",") : String(key.get(defaultSettings())))
        : parts.slice(2).join(" ");
      if (action === "set" && !raw) {
        ctx.ui.notify(`Usage: /freepi config set ${key.path} <value>`, "warning");
        return;
      }
      const next = structuredClone(await effectiveSettings());
      try {
        setSetting(next, key.path, raw);
      } catch (e) {
        ctx.ui.notify(`free-pi config: ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }
      await saveSettings(next);
      applySettings(next);
      const note = key.restart ? " Restart omp to apply." : "";
      ctx.ui.notify(`${key.path} = ${formatValue(key, next)}${note}`, "info");
      return;
    }
    ctx.ui.notify(`Unknown config action "${action}". Run /freepi config help.`, "error");
  };

  const subcommands: CompletionItem[] = [
    { value: "quota", label: "quota", description: "Full daily credit, usage, and refill report" },
    { value: "models", label: "models", description: "List free and paid models" },
    { value: "config", label: "config", description: "Show or change plugin settings" },
    { value: "settings", label: "settings", description: "Alias for /freepi config" },
    { value: "login", label: "login", description: "How to sign in" },
    { value: "server", label: "server", description: "Loopback server URL and cache stats" },
    { value: "help", label: "help", description: "List available subcommands" },
  ];

  pi.registerCommand("freepi", {
    description: "free-pi status, quota, models, config, login, and server",
    input: { hint: "<quota|models|config|settings|login|server|help>" },
    getArgumentCompletions(prefix: string): CompletionItem[] {
      const text = prefix.trim();
      const head = /^(config|settings)(?:\s+([\s\S]*))?$/i.exec(text);
      if (head) return configCompletions(head[2] ?? "");
      const p = text.toLowerCase();
      return subcommands.filter((c) => c.value.startsWith(p));
    },
    handler: async (args: string, ctx: CommandCtx) => {
      const trimmed = args.trim();
      const sub = trimmed.toLowerCase();
      if (sub === "quota") return quota(ctx);
      if (sub === "models") return modelList(ctx);
      if (sub === "config" || sub === "settings" || sub.startsWith("config ") || sub.startsWith("settings ")) {
        return config(trimmed.split(/\s+/).slice(1).join(" "), ctx);
      }
      if (sub === "login") {
        ctx.ui.notify("Run /login freepi (or `omp login freepi`) to sign in with GitHub.", "info");
        return;
      }
      if (sub === "server") {
        const cache = running.ctx.cache.stats();
        ctx.ui.notify(`free-pi server: ${running.url}\nCache: ${cache.entries} entries, ${cache.hits} hits / ${cache.misses} misses\nLogin token: ${await loadToken() ? "present" : "missing"}`, "info");
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(`Usage: /freepi [quota|models|config|settings|login|server|help]\n${subcommands.map((c) => `  ${c.value.padEnd(9)} ${c.description}`).join("\n")}`, "info");
        return;
      }
      await status(ctx);
    },
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
