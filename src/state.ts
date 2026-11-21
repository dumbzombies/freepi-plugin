// Shared runtime state: one upstream session per process, spent-session
// replay, and quota lookups. Forked from freepi-proxy's src/state.ts; the
// dashboard loops, token polling and settle reconciliation are gone.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SESSION_ID_PATH, CREDITS_PER_USD } from "./config.ts";
import type { Upstream, MeStats } from "./upstream.ts";
import type { ResponseCache, CacheStats } from "./cache.ts";

export interface PluginState {
  sessionId: string;
  startedAt: number;
}

export interface Ctx {
  upstream: Upstream;
  state: PluginState;
  cache: ResponseCache;
  /** Effective plugin settings for model filtering and live toggles. */
  settings: import("./settings.ts").Settings;
  /** Gravity context for the ad cycle, when the SDK is available. */
  gravityContext?: (jwt: string) => string | undefined;
}

/** Stable per-install session id: reuse across restarts so the server does not
 * count every plugin launch as a new concurrent session (account limit is 4). */
async function loadSessionId(): Promise<string> {
  try {
    const saved = (await readFile(SESSION_ID_PATH, "utf8")).trim();
    if (/^[0-9a-f-]{36}$/i.test(saved)) return saved;
  } catch { /* first run */ }
  return crypto.randomUUID();
}

export async function persistSessionId(id: string): Promise<void> {
  try {
    await mkdir(dirname(SESSION_ID_PATH), { recursive: true });
    await writeFile(SESSION_ID_PATH, id);
  } catch { /* in-memory id still works */ }
}

export async function createState(): Promise<PluginState> {
  const sessionId = await loadSessionId();
  await persistSessionId(sessionId);
  return { sessionId, startedAt: Date.now() };
}

// ---------- upstream sessions ----------
//
// free-pi meters a *session* (one CLI run, identified by x-session-id). Once a
// session has spent its token budget, every later completion fails with
// "session is too long" even after compaction. The CLI starts a new session
// each launch; this plugin retires a spent session and replays once, which is
// what keeps a long agent run working.

const SESSION_EXHAUSTED =
  /session[\s_-]*(?:is[\s_-]*)?too[\s_-]*long|session_too_long|session[\s_-]*(?:token[\s_-]*)?(?:limit|budget|quota|cap)\b|session[\s_-]*(?:exhausted|spent)/i;

export function isSessionTooLong(status: number, body: string): boolean {
  if (status < 400) return false;
  if (/concurrent[\s_-]*session/i.test(body)) return false;
  return SESSION_EXHAUSTED.test(body);
}

export async function rotateSession(state: PluginState, reason: string): Promise<string> {
  const previous = state.sessionId;
  const id = crypto.randomUUID();
  state.sessionId = id;
  await persistSessionId(id);
  console.warn(`[freepi-plugin] upstream session rotated (${reason}); retired ${previous}`);
  return id;
}

export interface SessionCompletion {
  upstream: Response;
  sessionId: string;
  retried: boolean;
}

function replayed(res: Response, body: string): Response {
  const headers = new Headers();
  const ctype = res.headers.get("content-type");
  if (ctype) headers.set("content-type", ctype);
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/** Send one completion as a CLI-style turn (ad cycle + turn id). If upstream
 * says the session itself is spent, rotate and replay once on a fresh one. */
export async function completeWithSessionRetry(
  ctx: Ctx,
  jwt: string,
  body: string,
  signal: AbortSignal,
): Promise<SessionCompletion> {
  const send = (sessionId: string): Promise<Response> => {
    const turnId = crypto.randomUUID();
    const gravity = ctx.gravityContext?.(jwt);
    // The ad cycle must run for this turn id on this session, or upstream
    // pauses the completion with ads_required.
    ctx.upstream.runAdCycle(jwt, sessionId, turnId, gravity);
    return ctx.upstream.completions(jwt, body, signal, { sessionId, turnId, gravityContext: gravity });
  };

  const first = await send(ctx.state.sessionId);
  if (first.ok) return { upstream: first, sessionId: ctx.state.sessionId, retried: false };

  const text = await first.text().catch(() => "");
  if (!isSessionTooLong(first.status, text)) {
    return { upstream: replayed(first, text), sessionId: ctx.state.sessionId, retried: false };
  }
  const sessionId = await rotateSession(ctx.state, `upstream ${first.status}: ${text.slice(0, 120)}`);
  return { upstream: await send(sessionId), sessionId, retried: true };
}

// ---------- quota ----------

export interface QuotaView {
  ok: boolean;
  error: string | null;
  handle: string | null;
  tier: string | null;
  lane: string | null;
  notice: string | null;
  quota: {
    allowance_credits: number | null;
    remaining_credits_today: number | null;
    used_credits_today: number | null;
    remaining_pct: number | null;
    spent_usd_today: number | null;
    cap_usd_today: number | null;
    refill_at: string | null;
    refill_in_ms: number | null;
  };
  usage: {
    requests_today: number | null;
    prompt_tokens_today: number | null;
    completion_tokens_today: number | null;
    lifetime_requests: number | null;
    streak_days: number | null;
  };
  cache: CacheStats;
}

/** Authoritative quota view: /me/stats plus /me notice. */
export async function quotaView(ctx: Ctx, jwt: string): Promise<QuotaView> {
  const [live, me] = await Promise.all([ctx.upstream.stats(jwt), ctx.upstream.me(jwt)]);
  const allowance = live?.allowance_credits ?? null;
  const remaining = live?.remaining_credits_today ?? null;
  const refillAt = live?.refill_at ?? null;
  const refillInMs = refillAt ? Math.max(0, Date.parse(refillAt) - Date.now()) : null;
  const used = allowance != null && remaining != null ? allowance - remaining : null;
  return {
    ok: live !== null,
    error: live ? null : "no_stats_yet",
    handle: me?.handle ?? null,
    tier: live?.tier ?? me?.tier ?? null,
    lane: live?.lane ?? me?.lane ?? null,
    notice: me?.notice ?? null,
    quota: {
      allowance_credits: allowance,
      remaining_credits_today: remaining,
      used_credits_today: used != null ? Math.round(used * 10) / 10 : null,
      remaining_pct: allowance != null && remaining != null && allowance > 0
        ? Math.round((remaining / allowance) * 1000) / 10
        : null,
      spent_usd_today: live?.spent_usd_today ?? null,
      cap_usd_today: live?.cap_usd_today ?? null,
      refill_at: refillAt,
      refill_in_ms: refillInMs,
    },
    usage: {
      requests_today: live?.request_count_today ?? null,
      prompt_tokens_today: live?.prompt_tokens_today ?? null,
      completion_tokens_today: live?.completion_tokens_today ?? null,
      lifetime_requests: live?.lifetime_requests ?? null,
      streak_days: live?.streak?.days ?? null,
    },
    cache: ctx.cache.stats(),
  };
}

export { CREDITS_PER_USD };
export type { MeStats };
