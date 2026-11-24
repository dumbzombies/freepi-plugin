// Exact-response cache for completions: byte-identical requests reuse the
// upstream body instead of paying for another turn.
//
// Two tiers: an in-memory LRU and an optional on-disk tier shared by every host
// (omp, opencode, CLI). The disk tier is what makes hits survive restarts and
// lets one host's paid turn serve the other.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR, CACHE_ENABLED, CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, CACHE_TTL_MS } from "./config.ts";

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
  /** Disk tier directory; null keeps the cache in memory only. */
  dir?: string | null;
  now?: () => number;
}

export type CacheRun =
  | { hit: true; payload: CachedPayload; layer: "memory" | "disk" }
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
  /** Bytes served from cache without contacting upstream. */
  savedBytes: number;
  entries: number;
  bytes: number;
  hitRate: number;
}

interface Entry {
  /** null for a disk entry that has not been read yet. */
  payload: CachedPayload | null;
  size: number;
  createdAt: number;
}

export interface CacheSource {
  status: number;
  ctype: string;
  upstream: Response;
  cacheable: boolean;
}

interface DiskIndex {
  version: 1;
  entries: Record<string, { size: number; createdAt: number; status: number; ctype: string }>;
}

const HASH_PREFIX = "v2\n";

/** Sort object keys so hosts emitting the same request in a different field
 * order hash identically. Native JSON.stringify of this copy measures ~25%
 * faster than building the text by hand. */
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

/**
 * Drop request fields that do not change the response bytes. A host that sends
 * `"stream": false` and one that omits it get the same JSON body, so they must
 * produce the same key; `stream_options` is meaningless for a JSON response.
 */
function normalizeForCache(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const body = { ...(parsed as Record<string, unknown>) };
  if (body.stream !== true) {
    delete body.stream;
    delete body.stream_options;
  }
  return body;
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
  private readonly dir: string | null;
  private readonly entries = new Map<string, Entry>();
  /** Response metadata for disk entries, which carry no payload until read. */
  private readonly status = new Map<string, number>();
  /** Keys evicted here: the merge in writeIndex must not resurrect them. */
  private readonly removed = new Set<string>();
  private readonly ctype = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<CachedPayload | null>>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private savedBytes = 0;
  /** Resolves once the disk index is loaded; every tier-2 lookup awaits it. */
  private readonly loaded: Promise<void>;

  constructor(opts?: Partial<CacheOptions>) {
    const ttl = opts?.ttlMs ?? CACHE_TTL_MS;
    const maxEntries = opts?.maxEntries ?? CACHE_MAX_ENTRIES;
    const maxBytes = opts?.maxBytes ?? CACHE_MAX_BYTES;
    this.enabled = opts?.enabled ?? CACHE_ENABLED;
    this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : 3_600_000;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 300;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 32 * 1024 * 1024;
    this.now = opts?.now ?? Date.now;
    this.dir = opts?.dir === undefined ? CACHE_DIR : opts.dir;
    this.loaded = this.dir ? this.loadDisk() : Promise.resolve();
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

  /** Stable key for a request body, or null when the body is not JSON. */
  key(bodyText: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return null;
    }
    return createHash("sha256")
      .update(`${HASH_PREFIX}${JSON.stringify(canonical(normalizeForCache(parsed)))}`)
      .digest("hex");
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      savedBytes: this.savedBytes,
      entries: this.entries.size,
      bytes: this.bytes,
      hitRate: total ? this.hits / total : 0,
    };
  }

  async run(
    key: string,
    produce: () => Promise<CacheSource>,
    opts?: { store?: boolean; onPayload?: (payload: CachedPayload) => void },
  ): Promise<CacheRun> {
    const caching = this.enabled && opts?.store !== false;

    if (caching) {
      const cached = await this.lookup(key);
      if (cached) {
        this.hits++;
        this.savedBytes += cached.payload.body.byteLength;
        return { hit: true, payload: cached.payload, layer: cached.layer };
      }
      const pending = this.inflight.get(key);
      if (pending) {
        const payload = await pending.catch(() => null);
        if (payload) {
          this.hits++;
          this.savedBytes += payload.body.byteLength;
          return { hit: true, payload, layer: "memory" };
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
    void this.drain(key, drain, src, caching, opts?.onPayload).then(settle, () => settle(null));
    return { hit: false, status, ctype, stream, done };
  }

  private async drain(
    key: string,
    drain: ReadableStream<Uint8Array>,
    src: CacheSource,
    store: boolean,
    onPayload?: (payload: CachedPayload) => void,
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
    if (tooBig) return null;
    const payload: CachedPayload = { status: src.status, ctype: src.ctype, body: concat(chunks, size) };
    // Usage telemetry runs on every successful body, cached or not.
    if (src.cacheable) onPayload?.(payload);
    if (store && src.cacheable) await this.store(key, payload);
    return payload;
  }

  private async lookup(key: string): Promise<{ payload: CachedPayload; layer: "memory" | "disk" } | null> {
    await this.loaded;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.delete(key);
      return null;
    }
    let layer: "memory" | "disk" = "memory";
    if (!entry.payload) {
      if (!this.dir) {
        this.delete(key);
        return null;
      }
      try {
        const body = new Uint8Array(await readFile(this.bodyPath(key)));
        entry.payload = { status: this.status.get(key) ?? 200, ctype: this.ctype.get(key) ?? "application/json", body };
        layer = "disk";
      } catch {
        this.delete(key);
        return null;
      }
    }
    // LRU: re-inserting moves the key to the newest position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { payload: entry.payload, layer };
  }

  private async store(key: string, payload: CachedPayload): Promise<void> {
    this.delete(key);
    this.evictExpired();
    this.entries.set(key, { payload, size: payload.body.byteLength, createdAt: this.now() });
    this.bytes += payload.body.byteLength;
    this.status.set(key, payload.status);
    this.ctype.set(key, payload.ctype);
    // Bodies are part of the shared tier: a caller that awaited `done` can
    // assume another process sees the entry.
    if (this.dir) await this.writeDisk(key, payload).catch(() => undefined);
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
    this.removed.add(key);
    this.bytes -= entry.size;
    this.entries.delete(key);
    this.status.delete(key);
    this.ctype.delete(key);
    if (this.dir) void unlink(this.bodyPath(key)).catch(() => undefined);
  }

  // ---------- disk tier ----------

  private bodyPath(key: string): string {
    return join(this.dir as string, `${key}.bin`);
  }

  private get indexPath(): string {
    return join(this.dir as string, "index.json");
  }

  /** Load the index only; bodies are read on demand so startup stays cheap. */
  private async loadDisk(): Promise<void> {
    try {
      await mkdir(this.dir as string, { recursive: true });
      const raw = JSON.parse(await readFile(this.indexPath, "utf8")) as DiskIndex;
      if (raw.version !== 1 || !raw.entries) return;
      const now = this.now();
      for (const [key, meta] of Object.entries(raw.entries)) {
        if (now - meta.createdAt > this.ttlMs) continue;
        this.entries.set(key, { payload: null, size: meta.size, createdAt: meta.createdAt });
        this.bytes += meta.size;
        this.status.set(key, meta.status);
        this.ctype.set(key, meta.ctype);
      }
      while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.delete(oldest.value);
      }
    } catch {
      // Missing or unreadable index: start cold, memory tier still works.
    }
  }

  private async writeDisk(key: string, payload: CachedPayload): Promise<void> {
    const dir = this.dir as string;
    const tmp = join(dir, `${key}.${process.pid}.tmp`);
    await writeFile(tmp, payload.body);
    await rename(tmp, this.bodyPath(key));
    await this.writeIndex();
  }

  private async writeIndex(): Promise<void> {
    const dir = this.dir as string;
    // Another process shares this directory (omp's in-process server and the
    // opencode service both use it). Merge what is on disk so neither writer
    // drops the other's entries.
    const entries: DiskIndex["entries"] = {};
    try {
      const disk = JSON.parse(await readFile(this.indexPath, "utf8")) as DiskIndex;
      if (disk.version === 1 && disk.entries) {
        const now = this.now();
        for (const [key, meta] of Object.entries(disk.entries)) {
          if (this.removed.has(key)) continue;
          if (now - meta.createdAt <= this.ttlMs) entries[key] = meta;
        }
      }
    } catch {
      // No index yet, or a torn read from a concurrent writer: ours is enough.
    }
    for (const [key, entry] of this.entries) {
      const status = this.status.get(key);
      const ctype = this.ctype.get(key);
      if (entry.payload === null && (status === undefined || ctype === undefined)) continue;
      entries[key] = {
        size: entry.size,
        createdAt: entry.createdAt,
        status: entry.payload?.status ?? status ?? 200,
        ctype: entry.payload?.ctype ?? ctype ?? "application/json",
      };
    }
    // Unique temp name: two writers must not rename over the same file.
    const tmp = join(dir, `index.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify({ version: 1, entries } satisfies DiskIndex));
    await rename(tmp, this.indexPath);
  }
}
