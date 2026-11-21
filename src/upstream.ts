// free-pi upstream client: catalog, account stats, completions, ads.
// Forked from freepi-proxy's src/upstream.ts; tools and MCP helpers dropped.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BASE_URL, CLIENT_VERSION_PATH, FALLBACK_CLIENT_VERSION, UA } from "./config.ts";

/** Compare dotted versions: negative when a < b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x) || 0);
  const pb = b.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const VERSION_RE = /\b(\d+\.\d+\.\d+)\b/;

export interface CatalogModel {
  id: string;
  name: string;
  display_name?: string;
  free?: boolean;
  usage_x?: string | null;
  note?: string | null;
  unavailable?: boolean;
  section?: string;
  multiplier: number;
}

export interface Catalog {
  models: CatalogModel[];
  latest: string;
  min: string;
  defaultModel: string;
  fetchedAt: number;
}

export interface MeStats {
  tier: string;
  cap_usd_today: number;
  spent_usd_today: number;
  remaining_usd_today: number;
  credit_credits?: number;
  allowance_credits?: number;
  remaining_credits_today?: number;
  refill_at?: string;
  lane?: string;
  request_count_today?: number;
  prompt_tokens_today?: number;
  completion_tokens_today?: number;
  streak?: { days: number };
  lifetime_requests?: number;
}

export class Upstream {
  catalog: Catalog | null = null;
  private clientVersion = FALLBACK_CLIENT_VERSION;
  private modelIndex = new Map<string, number>();
  private readonly baseUrl: string;

  constructor(baseUrl: string = BASE_URL) {
    this.baseUrl = baseUrl;
    try {
      const saved = readFileSync(CLIENT_VERSION_PATH, "utf8").trim();
      if (VERSION_RE.test(saved) && compareVersions(saved, this.clientVersion) > 0) this.clientVersion = saved;
    } catch { /* first run */ }
  }

  get version(): string { return this.clientVersion; }

  adoptVersion(v: string | null | undefined): void {
    if (!v || !VERSION_RE.test(v) || compareVersions(v, this.clientVersion) <= 0) return;
    this.clientVersion = v;
    try {
      mkdirSync(dirname(CLIENT_VERSION_PATH), { recursive: true });
      writeFileSync(CLIENT_VERSION_PATH, v);
    } catch { /* in-memory adoption still fixes this run */ }
  }

  noteRequiredVersion(body: string): void {
    const m = VERSION_RE.exec(body);
    if (m) this.adoptVersion(m[1]);
  }

  /** Survive the forced-update gate: learn the required version, replay once. */
  private async authedFetch(url: URL, init: () => RequestInit): Promise<Response> {
    const res = await fetch(url, init());
    if (res.status !== 426) return res;
    const text = await res.text().catch(() => "");
    this.noteRequiredVersion(text);
    await this.refreshCatalog();
    return fetch(url, init());
  }

  authHeaders(jwt: string): Record<string, string> {
    return {
      authorization: `Bearer ${jwt}`,
      "x-client-version": this.clientVersion,
      "user-agent": UA,
    };
  }

  /** GET /client-version — public; parses usage multipliers out of names. */
  async refreshCatalog(): Promise<Catalog | null> {
    try {
      const res = await fetch(new URL("/client-version", this.baseUrl), {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return this.catalog;
      const d = (await res.json()) as {
        min: string; latest: string; model: string;
        models: Array<{
          id: string; name: string; display_name?: string; free?: boolean;
          usage_x?: string | null; note?: string | null;
          unavailable?: boolean; section?: string;
        }>;
      };
      this.adoptVersion(d.latest);
      this.adoptVersion(d.min);
      const models = (d.models || []).map((m) => ({
        ...m,
        multiplier: Number(m.usage_x ?? /~([\d.]+)x/.exec(m.name)?.[1] ?? 1),
      }));
      const index = new Map<string, number>();
      for (const m of models) index.set(m.id, m.multiplier);
      this.modelIndex = index;
      this.catalog = {
        latest: d.latest,
        min: d.min,
        defaultModel: d.model,
        fetchedAt: Date.now(),
        models,
      };
      return this.catalog;
    } catch {
      return this.catalog;
    }
  }

  multiplier(id: string): number {
    return this.modelIndex.get(id) ?? 1;
  }

  async me(jwt: string): Promise<{ handle?: string; tier?: string; lane?: string; notice?: string } | null> {
    try {
      const res = await this.authedFetch(new URL("/me", this.baseUrl), () => ({ headers: this.authHeaders(jwt) }));
      if (!res.ok) return null;
      return (await res.json()) as { handle?: string; tier?: string; lane?: string; notice?: string };
    } catch { return null; }
  }

  /** GET /me/stats with the JWT. */
  async stats(jwt: string): Promise<MeStats | null> {
    try {
      const res = await this.authedFetch(new URL("/me/stats", this.baseUrl), () => ({ headers: this.authHeaders(jwt) }));
      if (!res.ok) return null;
      return (await res.json()) as MeStats;
    } catch {
      return null;
    }
  }

  /** POST /v1/chat/completions — raw upstream Response for streaming. */
  completions(
    jwt: string,
    body: string,
    signal: AbortSignal,
    opts?: { sessionId?: string; turnId?: string; gravityContext?: string },
  ): Promise<Response> {
    const extra: Record<string, string> = {};
    if (opts?.sessionId) extra["x-session-id"] = opts.sessionId;
    if (opts?.turnId) extra["x-turn-id"] = opts.turnId;
    if (opts?.gravityContext) extra["x-gravity-context"] = opts.gravityContext;
    return this.authedFetch(new URL("/v1/chat/completions", this.baseUrl), () => ({
      method: "POST",
      signal,
      headers: {
        ...this.authHeaders(jwt),
        "content-type": "application/json",
        ...extra,
      },
      body,
    }));
  }

  /** GET /ads/next?slot=... — 204/!ok => null. */
  async fetchAdNext(
    jwt: string,
    slot: string,
    sessionId: string,
    opts?: { turnId?: string; trigger?: string; gravityContext?: string },
  ): Promise<any | null> {
    try {
      const extra: Record<string, string> = {
        "x-session-id": sessionId,
        ...clientEnvHeaders(),
      };
      if (opts?.turnId) extra["x-turn-id"] = opts.turnId;
      if (opts?.trigger) extra["x-ad-trigger"] = opts.trigger;
      if (opts?.gravityContext) extra["x-gravity-context"] = opts.gravityContext;
      const res = await fetch(new URL(`/ads/next?slot=${encodeURIComponent(slot)}`, this.baseUrl), {
        headers: { ...this.authHeaders(jwt), ...extra },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 204 || !res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /** POST /ads/impression (best-effort). */
  async postImpression(
    jwt: string,
    adId: string,
    clickToken: string,
    sessionId: string,
    impFired = false,
    turnId?: string,
  ): Promise<void> {
    try {
      const extra: Record<string, string> = { "x-session-id": sessionId };
      if (turnId) extra["x-turn-id"] = turnId;
      await fetch(new URL("/ads/impression", this.baseUrl), {
        method: "POST",
        headers: { ...this.authHeaders(jwt), "content-type": "application/json", ...extra },
        body: JSON.stringify({ ad_id: adId, click_token: clickToken, ...(impFired ? { imp_fired: true } : {}) }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch { /* best-effort */ }
  }

  /**
   * CLI-shaped ad cycle for one turn: fetch the banner ad, fire the Gravity
   * impression pixel from this machine, report the impression with imp_fired.
   * Fire-and-forget — must never delay or break the completion.
   */
  runAdCycle(jwt: string, sessionId: string, turnId: string, gravityContext?: string): void {
    void (async () => {
      try {
        const ad = await this.fetchAdNext(jwt, "banner", sessionId, { turnId, trigger: "user_message", gravityContext });
        if (!ad || !ad.ad_id || !ad.click_token) return;
        const isGravityImp = ad.source === "gravity" && typeof ad.imp_url === "string"
          && /^https:\/\/[^/]*trygravity\.(ai|com)\//.test(ad.imp_url);
        if (isGravityImp) await fetch(ad.imp_url, { signal: AbortSignal.timeout(3_000) }).catch(() => {});
        await this.postImpression(jwt, ad.ad_id, ad.click_token, sessionId, isGravityImp, turnId);
      } catch { /* best-effort */ }
    })();
  }
}

/** Locale/os headers the 0.6.19 CLI attaches to ad calls. */
export function clientEnvHeaders(): Record<string, string> {
  const out: Record<string, string> = {
    "x-client-os": process.platform,
    "x-client-arch": process.arch,
  };
  try {
    const o = new Intl.DateTimeFormat().resolvedOptions();
    if (o.timeZone) out["x-client-timezone"] = o.timeZone;
    if (o.locale) out["x-client-locale"] = o.locale;
  } catch { /* ignore */ }
  return out;
}
