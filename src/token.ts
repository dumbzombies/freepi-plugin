// free-pi token storage and GitHub device-flow login.
// Forked from freepi-proxy's src/token.ts; the dashboard LoginManager is gone:
// the pi/omp OAuth hook drives the same flow through callbacks.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BASE_URL, CONSENT_VERSION, TOKEN_PATH, UA } from "./config.ts";

export interface DeviceFlow {
  session_id: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in?: number;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify(body),
  });
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// ---------- token file (plugin-owned; never overwrites free-pi-cli's file) ----------

export async function loadToken(): Promise<string | null> {
  try {
    const raw = await readFile(TOKEN_PATH, "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify({ token }), { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600).catch(() => {});
}

/** Seconds-since-epoch expiry from the JWT, or null when it has no exp claim. */
export function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ---------- token validation ----------

/** GET /me with the JWT. */
export async function checkToken(token: string): Promise<{ ok: true; handle?: string } | { ok: false; code: "rejected" | "unknown" }> {
  try {
    const res = await fetch(new URL("/me", BASE_URL), {
      headers: { authorization: `Bearer ${token}`, "user-agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { ok: false, code: "rejected" };
    if (!res.ok) return { ok: false, code: "unknown" };
    const body = (await res.json().catch(() => ({}))) as { handle?: unknown };
    return { ok: true, handle: typeof body.handle === "string" ? body.handle : undefined };
  } catch {
    return { ok: false, code: "unknown" };
  }
}

// ---------- device flow (same endpoints as the CLI) ----------

export async function startDeviceFlow(): Promise<DeviceFlow> {
  let res: Response;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      res = await postJson("/auth/github/device", {});
      if (!res.ok) throw new Error(`device flow start failed: HTTP ${res.status}`);
      return (await res.json()) as DeviceFlow;
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && /HTTP/.test(err.message)) throw err;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 1500 * attempt);
      await promise;
    }
  }
  throw new Error(`network unreachable: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function submitConsent(sessionId: string): Promise<void> {
  const res = await postJson("/auth/consent", { session_id: sessionId, consent_version: CONSENT_VERSION });
  if (!res.ok) throw new Error(`consent submission failed: HTTP ${res.status}`);
}

async function pollOnce(sessionId: string): Promise<string | "waiting" | "slowdown"> {
  const res = await postJson("/auth/token", { session_id: sessionId });
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (body.code === "consent_required") throw new Error("consent_required: consent was not recorded");
    throw new Error(`token poll failed: HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`token poll failed: HTTP ${res.status}`);
  const parsed = (await res.json()) as { token?: string; code?: string; retry_after?: number };
  if (typeof parsed.token === "string" && parsed.token) return parsed.token;
  if (parsed.code === "slow_down") return "slowdown";
  return "waiting";
}

export interface LoginCallbacks {
  onDeviceCode(info: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }): void;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}

/** Run the CLI's device flow to a token. Reports the code once, then polls. */
export async function deviceLogin(callbacks: LoginCallbacks): Promise<string> {
  const flow = await startDeviceFlow();
  callbacks.onDeviceCode({
    userCode: flow.user_code,
    verificationUri: flow.verification_uri,
    intervalSeconds: flow.interval,
    expiresInSeconds: flow.expires_in,
  });
  await submitConsent(flow.session_id);

  const interval = Math.max(Number(flow.interval) || 5, 3) * 1000;
  const deadline = Date.now() + (Number(flow.expires_in) || 900) * 1000;
  for (;;) {
    if (callbacks.signal?.aborted) throw new Error("login cancelled");
    if (Date.now() > deadline) throw new Error("device code expired");
    let result: string | "waiting" | "slowdown";
    try {
      result = await pollOnce(flow.session_id);
    } catch (err) {
      // tolerate transient network errors like the CLI does
      callbacks.onProgress?.(err instanceof Error ? err.message : String(err));
      await sleep(Math.max(interval, 5_000));
      continue;
    }
    if (typeof result === "string" && result !== "waiting" && result !== "slowdown") {
      await saveToken(result);
      return result;
    }
    if (result === "slowdown") callbacks.onProgress?.("GitHub says slow down; retrying in 10s");
    await sleep(result === "slowdown" ? 10_000 : interval);
  }
}
