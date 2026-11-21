// Exact-response cache for completions: byte-identical requests reuse the
// upstream body instead of paying for another turn. Forked from freepi-proxy.

import { createHash } from "node:crypto";
import { CACHE_ENABLED, CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, CACHE_TTL_MS } from "./config.ts";

export interface CachedPayload {
  status: number;
  ctype: string;
  body: Uint8Array;
}

export interface CacheOptions {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  now?: () => number;
}

export type CacheRun =
  | { hit: true; payload: CachedPayload }
  | {
      hit: false;
      status: number;
      ctype: string;
      stream: ReadableStream<Uint8Array>;
      done: Promise<CachedPayload | null>;
    };

export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
  bytes: number;
  hitRate: number;
}

interface Entry {
  payload: CachedPayload;
  createdAt: number;
}

export interface CacheSource {
  status: number;
  ctype: string;
  upstream: Response;
  cacheable: boolean;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonical(src[k]);
    return out;
  }
  return value;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}

export class ResponseCache {
  enabled: boolean;
  private ttlMs: number;
  private maxEntries: number;
  private maxBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<CachedPayload | null>>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(opts?: Partial<CacheOptions>) {
    const ttl = opts?.ttlMs ?? CACHE_TTL_MS;
    const maxEntries = opts?.maxEntries ?? CACHE_MAX_ENTRIES;
    const maxBytes = opts?.maxBytes ?? CACHE_MAX_BYTES;
    this.enabled = opts?.enabled ?? CACHE_ENABLED;
    this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : 3_600_000;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 300;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 32 * 1024 * 1024;
    this.now = opts?.now ?? Date.now;
  }

  /** Apply new limits in place; existing entries are trimmed to fit. */
  configure(opts: Partial<CacheOptions>): void {
    if (opts.enabled !== undefined) this.enabled = opts.enabled;
    if (opts.ttlMs !== undefined && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) this.ttlMs = opts.ttlMs;
    if (opts.maxEntries !== undefined && Number.isFinite(opts.maxEntries) && opts.maxEntries > 0) {
      this.maxEntries = Math.floor(opts.maxEntries);
    }
    if (opts.maxBytes !== undefined && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0) {
      this.maxBytes = Math.floor(opts.maxBytes);
    }
    this.evictExpired();
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  key(bodyText: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return null;
    }
    return createHash("sha256").update("v1\n" + JSON.stringify(canonical(parsed))).digest("hex");
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      bytes: this.bytes,
      hitRate: total ? this.hits / total : 0,
    };
  }

  async run(key: string, produce: () => Promise<CacheSource>, opts?: { store?: boolean }): Promise<CacheRun> {
    const caching = this.enabled && opts?.store !== false;

    if (caching) {
      const cached = this.lookup(key);
      if (cached) {
        this.hits++;
        return { hit: true, payload: cached };
      }
      const pending = this.inflight.get(key);
      if (pending) {
        const payload = await pending.catch(() => null);
        if (payload) {
          this.hits++;
          return { hit: true, payload };
        }
      }
    }

    this.misses++;
    const { promise: done, resolve: settle } = Promise.withResolvers<CachedPayload | null>();
    if (caching) {
      this.inflight.set(key, done);
      void done.then(() => {
        if (this.inflight.get(key) === done) this.inflight.delete(key);
      });
    }

    let src: CacheSource;
    try {
      src = await produce();
    } catch (e) {
      settle(null);
      throw e;
    }
    const { status, ctype } = src;
    const body = src.upstream.body;

    if (!body) {
      const payload: CachedPayload = { status, ctype, body: new Uint8Array(0) };
      settle(payload);
      return { hit: false, status, ctype, stream: emptyStream(), done };
    }

    const [stream, drain] = body.tee();
    void this.drain(key, drain, src, caching).then(settle, () => settle(null));
    return { hit: false, status, ctype, stream, done };
  }

  private async drain(
    key: string,
    drain: ReadableStream<Uint8Array>,
    src: CacheSource,
    store: boolean,
  ): Promise<CachedPayload | null> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let tooBig = false;
    const reader = drain.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (tooBig || !value) continue;
        if (size + value.byteLength > this.maxBytes) {
          tooBig = true;
          chunks.length = 0;
          continue;
        }
        chunks.push(value);
        size += value.byteLength;
      }
    } catch {
      return null;
    }
    if (tooBig || !src.cacheable) return null;
    const payload: CachedPayload = { status: src.status, ctype: src.ctype, body: concat(chunks, size) };
    if (store) this.store(key, payload);
    return payload;
  }

  private lookup(key: string): CachedPayload | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.payload;
  }

  private store(key: string, payload: CachedPayload): void {
    this.delete(key);
    this.evictExpired();
    this.entries.set(key, { payload, createdAt: this.now() });
    this.bytes += payload.body.byteLength;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) this.delete(key);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.payload.body.byteLength;
    this.entries.delete(key);
  }
}
