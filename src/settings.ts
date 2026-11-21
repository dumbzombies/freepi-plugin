// Persisted plugin settings. Precedence: built-in/env defaults < settings.json.
// Mutations land on disk immediately; live-capable values are re-applied by
// the extension, the rest take effect on the next host start.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BASE_URL,
  CACHE_ENABLED,
  CACHE_MAX_BYTES,
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  DATA_DIR,
  PREFERRED_PORT,
} from "./config.ts";

export interface Settings {
  baseUrl: string;
  port: number;
  cache: { enabled: boolean; ttlMs: number; maxEntries: number; maxBytes: number };
  ads: { gravity: boolean };
  models: { freeOnly: boolean; showPremium: boolean; hidden: string[]; contextWindow: number; maxTokens: number };
}

export const SETTINGS_PATH = join(DATA_DIR, "settings.json");

export function defaultSettings(): Settings {
  return {
    baseUrl: BASE_URL,
    port: PREFERRED_PORT,
    cache: {
      enabled: CACHE_ENABLED,
      ttlMs: CACHE_TTL_MS,
      maxEntries: CACHE_MAX_ENTRIES,
      maxBytes: CACHE_MAX_BYTES,
    },
    ads: { gravity: true },
    models: { freeOnly: false, showPremium: false, hidden: [], contextWindow: 200_000, maxTokens: 32_768 },
  };
}

export type SettingKey = {
  path: string;
  type: "string" | "number" | "boolean" | "list";
  description: string;
  /** true when the change needs a host restart to take effect. */
  restart: boolean;
  get(s: Settings): unknown;
  set(s: Settings, raw: string): void;
};

function parseBool(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (["true", "1", "on", "yes", "y"].includes(v)) return true;
  if (["false", "0", "off", "no", "n"].includes(v)) return false;
  throw new Error(`expected a boolean (true/false), got "${raw}"`);
}

function parseNumber(raw: string, min: number, max: number, label: string): number {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} must be an integer ${min}..${max}, got "${raw}"`);
  }
  return n;
}

export const SETTING_KEYS: SettingKey[] = [
  {
    path: "baseUrl",
    type: "string",
    description: "free-pi API base URL",
    restart: true,
    get: (s) => s.baseUrl,
    set: (s, raw) => {
      let url: URL;
      try {
        url = new URL(raw.trim());
      } catch {
        throw new Error(`baseUrl must be an absolute URL, got "${raw}"`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`baseUrl must be http(s), got "${raw}"`);
      }
      s.baseUrl = url.toString().replace(/\/+$/, "");
    },
  },
  {
    path: "port",
    type: "number",
    description: "preferred loopback port (probes upward when taken)",
    restart: true,
    get: (s) => s.port,
    set: (s, raw) => {
      s.port = parseNumber(raw, 1024, 65535, "port");
    },
  },
  {
    path: "cache.enabled",
    type: "boolean",
    description: "reuse byte-identical completion responses",
    restart: false,
    get: (s) => s.cache.enabled,
    set: (s, raw) => {
      s.cache.enabled = parseBool(raw);
    },
  },
  {
    path: "cache.ttlMs",
    type: "number",
    description: "cache entry lifetime in milliseconds",
    restart: false,
    get: (s) => s.cache.ttlMs,
    set: (s, raw) => {
      s.cache.ttlMs = parseNumber(raw, 1000, 30 * 24 * 3_600_000, "cache.ttlMs");
    },
  },
  {
    path: "cache.maxEntries",
    type: "number",
    description: "maximum cached responses",
    restart: false,
    get: (s) => s.cache.maxEntries,
    set: (s, raw) => {
      s.cache.maxEntries = parseNumber(raw, 1, 100_000, "cache.maxEntries");
    },
  },
  {
    path: "cache.maxBytes",
    type: "number",
    description: "maximum cached response bytes",
    restart: false,
    get: (s) => s.cache.maxBytes,
    set: (s, raw) => {
      s.cache.maxBytes = parseNumber(raw, 1024, 1024 ** 3, "cache.maxBytes");
    },
  },
  {
    path: "ads.gravity",
    type: "boolean",
    description: "attach Gravity ad context when the SDK is installed",
    restart: false,
    get: (s) => s.ads.gravity,
    set: (s, raw) => {
      s.ads.gravity = parseBool(raw);
    },
  },
  {
    path: "models.freeOnly",
    type: "boolean",
    description: "expose only catalog models marked free",
    restart: true,
    get: (s) => s.models.freeOnly,
    set: (s, raw) => {
      s.models.freeOnly = parseBool(raw);
    },
  },
  {
    path: "models.showPremium",
    type: "boolean",
    description: "show models that require purchased premium credits (403 without them)",
    restart: true,
    get: (s) => s.models.showPremium,
    set: (s, raw) => {
      s.models.showPremium = parseBool(raw);
    },
  },
  {
    path: "models.hidden",
    type: "list",
    description: "comma-separated model ids to hide",
    restart: true,
    get: (s) => s.models.hidden,
    set: (s, raw) => {
      s.models.hidden = [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
    },
  },
  {
    path: "models.contextWindow",
    type: "number",
    description: "advertised context window in tokens",
    restart: true,
    get: (s) => s.models.contextWindow,
    set: (s, raw) => {
      s.models.contextWindow = parseNumber(raw, 1000, 2_000_000, "models.contextWindow");
    },
  },
  {
    path: "models.maxTokens",
    type: "number",
    description: "advertised max output tokens",
    restart: true,
    get: (s) => s.models.maxTokens,
    set: (s, raw) => {
      s.models.maxTokens = parseNumber(raw, 1, 1_000_000, "models.maxTokens");
    },
  },
];

export function findKey(path: string): SettingKey | undefined {
  return SETTING_KEYS.find((k) => k.path === path);
}

/** Merge a parsed JSON object over defaults, ignoring unknown/invalid fields. */
function merge(raw: unknown): Settings {
  const s = defaultSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return s;
  const obj = raw as Record<string, unknown>;
  for (const key of SETTING_KEYS) {
    const parts = key.path.split(".");
    let value: unknown = obj;
    for (const part of parts) {
      value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    }
    if (value === undefined) continue;
    try {
      if (key.type === "list") {
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          key.set(s, value.join(","));
        }
      } else if (key.type === "boolean") {
        if (typeof value === "boolean") key.set(s, String(value));
      } else {
        key.set(s, String(value));
      }
    } catch {
      /* keep the default for invalid stored values */
    }
  }
  return s;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const text = await readFile(SETTINGS_PATH, "utf8");
    return merge(JSON.parse(text));
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

export async function resetSettings(): Promise<Settings> {
  await rm(SETTINGS_PATH, { force: true });
  return defaultSettings();
}

export function setSetting(settings: Settings, path: string, raw: string): Settings {
  const key = findKey(path);
  if (!key) throw new Error(`unknown setting "${path}"`);
  key.set(settings, raw);
  return settings;
}

export function formatValue(key: SettingKey, s: Settings): string {
  const value = key.get(s);
  if (Array.isArray(value)) return value.length ? value.join(",") : "(none)";
  return String(value);
}

export function formatSettings(s: Settings): string {
  const width = Math.max(...SETTING_KEYS.map((k) => k.path.length));
  const lines = SETTING_KEYS.map((k) => {
    const suffix = k.restart ? "  (restart)" : "";
    return `${k.path.padEnd(width)}  ${formatValue(k, s)}${suffix}`;
  });
  return [
    `free-pi settings — ${SETTINGS_PATH}`,
    ...lines,
    "Edit with: /freepi config set <key> <value>  ·  unset resets a key.",
  ].join("\n");
}
