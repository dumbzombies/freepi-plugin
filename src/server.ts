// In-process OpenAI-compatible server. This is the "self-contained API" the
// pi/omp provider points at: streaming chat completions straight from free-pi,
// the live model catalog, quota JSON, and the exact-response cache.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { PORT_ATTEMPTS } from "./config.ts";
import { ResponseCache } from "./cache.ts";
import { completeWithSessionRetry, createState, quotaView, type Ctx } from "./state.ts";
import { loadToken } from "./token.ts";
import { Upstream } from "./upstream.ts";
import { defaultSettings, type Settings } from "./settings.ts";
import { isModelVisible } from "./visibility.ts";

/** Request bodies larger than this are rejected: huge prompts should not
 * occupy process memory indefinitely. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export function createCtx(settings: Settings = defaultSettings()): Ctx {
  return {
    settings,
    upstream: new Upstream(settings.baseUrl),
    state: { sessionId: crypto.randomUUID(), startedAt: Date.now() },
    cache: new ResponseCache(settings.cache),
  };
}

/** Bearer token from the request. Hosts that configure a static apiKey (e.g.
 * opencode's provider block) send a placeholder string; only JWT-shaped values
 * are treated as credentials, so the stored token file stays authoritative. */
function bearer(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  const raw = typeof auth === "string" && /^Bearer\s+/i.test(auth)
    ? auth.replace(/^Bearer\s+/i, "").trim()
    : typeof req.headers["x-api-key"] === "string"
      ? (req.headers["x-api-key"] as string).trim()
      : "";
  if (!raw) return null;
  return raw.split(".").length === 3 ? raw : null;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** Stream a Web ReadableStream to a node response, aborting upstream when the
 * client disconnects. */
async function pipe(res: ServerResponse, stream: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
  const onClose = () => controller.abort();
  res.once("close", onClose);
  try {
    const node = Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>);
    node.on("error", () => {
      controller.abort();
      res.destroy();
    });
    node.pipe(res);
  } catch {
    controller.abort();
    res.destroy();
  }
}

function modelsPayload(ctx: Ctx): unknown {
  const data = (ctx.upstream.catalog?.models ?? [])
    .filter((m) => isModelVisible(m, ctx.settings))
    .filter((m) => !m.unavailable)
    .map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor((ctx.upstream.catalog?.fetchedAt ?? Date.now()) / 1000),
      owned_by: "freepi",
      name: m.display_name || m.name,
      free: m.free === true,
      multiplier: m.multiplier,
    }));
  return { object: "list", data };
}

async function completions(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const raw = await readBody(req);
  if (raw === null) {
    json(res, 413, { error: { message: "request body too large", type: "freepi_plugin_error" } });
    return;
  }
  const jwt = bearer(req) ?? (await loadToken());
  if (!jwt) {
    json(res, 401, {
      error: { message: "Not logged in to free-pi. Run /login freepi.", type: "freepi_plugin_error", code: "no_token" },
    });
    return;
  }

  const cacheKey = ctx.cache.key(raw);
  const controller = new AbortController();
  res.once("close", () => controller.abort());

  let run;
  try {
    run = await ctx.cache.run(
      cacheKey ?? crypto.randomUUID(),
      async () => {
        const out = await completeWithSessionRetry(ctx, jwt, raw, controller.signal);
        return {
          status: out.upstream.status,
          ctype: out.upstream.headers.get("content-type") || "application/json",
          upstream: out.upstream,
          cacheable: out.upstream.ok,
        };
      },
      { store: cacheKey !== null },
    );
  } catch (e) {
    json(res, 502, {
      error: { message: `Upstream connection failed: ${e instanceof Error ? e.message : String(e)}`, type: "freepi_plugin_error", code: "network" },
    });
    return;
  }

  if (run.hit) {
    res.writeHead(run.payload.status, {
      "content-type": run.payload.ctype,
      "cache-control": "no-cache",
      "x-freepi-cache": "hit",
      "content-length": run.payload.body.byteLength,
    });
    res.end(Buffer.from(run.payload.body));
    return;
  }

  res.writeHead(run.status, {
    "content-type": run.ctype,
    "cache-control": "no-cache",
    "x-freepi-cache": "miss",
    // nginx-style proxies must not buffer SSE
    "x-accel-buffering": "no",
  });
  await pipe(res, run.stream, controller);
}

export function createHandler(ctx: Ctx) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        json(res, 200, { ok: true, uptime_ms: Date.now() - ctx.state.startedAt });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        json(res, 200, modelsPayload(ctx));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await completions(req, res, ctx);
        return;
      }
      if (req.method === "GET" && (url.pathname === "/v1/quota" || url.pathname === "/quota")) {
        const jwt = bearer(req) ?? (await loadToken());
        if (!jwt) {
          json(res, 401, { error: { message: "Not logged in to free-pi. Run /login freepi.", code: "no_token" } });
          return;
        }
        json(res, 200, await quotaView(ctx, jwt));
        return;
      }
      json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}`, type: "freepi_plugin_error" } });
    } catch (e) {
      if (!res.headersSent) {
        json(res, 500, { error: { message: e instanceof Error ? e.message : String(e), type: "freepi_plugin_error" } });
      } else {
        res.destroy();
      }
    }
  };
}

export interface RunningServer {
  ctx: Ctx;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Bind loopback, probing upward when the preferred port is taken. */
export async function startServer(settings: Settings = defaultSettings()): Promise<RunningServer> {
  const ctx = createCtx(settings);
  ctx.state = await createState();
  const handler = createHandler(ctx);

  let lastError: unknown;
  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    const port = settings.port + i;
    const server: Server = createServer((req, res) => void handler(req, res));
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        lastError = err;
        resolve(false);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (!bound) continue;
    // Refreshing the catalog is public and cheap; the first /v1/models call
    // must not be the thing that pays for it.
    void ctx.upstream.refreshCatalog();
    return {
      ctx,
      port,
      url: `http://127.0.0.1:${port}/v1`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
  throw new Error(`could not bind a loopback port: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
