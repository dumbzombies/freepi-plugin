// Constants for the free-pi pi/omp plugin. Zero dependencies.

import { homedir } from "node:os";
import { join } from "node:path";

/** free-pi backend, overridable for dev. */
export const BASE_URL = process.env.FREEPI_BASE_URL || "https://api.freepi.ai";

/** Plugin data dir: token copy, session id, client version, cache settings. */
export const DATA_DIR = process.env.FREEPI_PLUGIN_DATA_DIR || join(homedir(), ".freepi-plugin");
export const TOKEN_PATH = join(DATA_DIR, "token");
export const SESSION_ID_PATH = join(DATA_DIR, "session-id");
export const CLIENT_VERSION_PATH = join(DATA_DIR, "client-version");

/** Consent version free-pi-cli 0.6.x submits during login (src/consent.ts). */
export const CONSENT_VERSION = "4";

/** Header the server's forced-update gate reads. */
export const FALLBACK_CLIENT_VERSION = "0.6.19";

/** Catalog refresh cadence while the plugin server is alive. */
export const CATALOG_REFRESH_MS = 10 * 60 * 1000;

/** Days of session id reuse before the id is rotated anyway. */
export const HISTORY_DAYS = 14;

/** Server peg: $1.125 daily cap = 15,000 credits → 1 credit = $0.000075. */
export const CREDITS_PER_USD = 15_000 / 1.125;

/** Local instant estimate: credits per token at 1x multiplier. */
export const EST_CREDITS_PER_TOKEN = 0.00222;

export const UA = "freepi-plugin/1.0";

/** Exact-response cache: on by default; FREEPI_CACHE=0 disables. */
export const CACHE_ENABLED = process.env.FREEPI_CACHE !== "0";
export const CACHE_TTL_MS = Number(process.env.FREEPI_CACHE_TTL_MS || 3_600_000);
export const CACHE_MAX_ENTRIES = Number(process.env.FREEPI_CACHE_MAX_ENTRIES || 300);
export const CACHE_MAX_BYTES = Number(process.env.FREEPI_CACHE_MAX_BYTES || 32 * 1024 * 1024);

/** Preferred port; the server probes upward when it is taken. */
export const PREFERRED_PORT = Number(process.env.FREEPI_PLUGIN_PORT || 8473);
export const PORT_ATTEMPTS = 20;
