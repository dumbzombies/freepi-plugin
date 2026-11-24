import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freepi-plugin-tombstone-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");

const { ResponseCache } = await import("../src/cache.ts");

function ok(n) {
  return {
    status: 200,
    ctype: "application/json",
    upstream: new Response(`{"n":${n}}`, { status: 200, headers: { "content-type": "application/json" } }),
    cacheable: true,
  };
}

/**
 * `removed` exists so this process's own evictions survive its index merge.
 * It must not act as a tombstone for entries another process wrote afterwards:
 * process A evicting a key says nothing about B's fresh copy of the same key.
 */
test("one process's eviction does not delete another process's fresh entry", async () => {
  const dir = join(home, "cache");
  // A uses a tiny cap so storing a second key evicts the first.
  const a = new ResponseCache({ enabled: true, ttlMs: 600_000, maxEntries: 1, maxBytes: 1 << 20, dir });
  const b = new ResponseCache({ enabled: true, ttlMs: 600_000, maxEntries: 100, maxBytes: 1 << 20, dir });
  const keyOf = (cache, text) => cache.key(`{"model":"m","messages":[{"role":"user","content":"${text}"}]}`);

  const shared = keyOf(a, "shared");
  await (await a.run(shared, async () => ok(1))).done;
  await (await a.run(keyOf(a, "filler"), async () => ok(2))).done; // evicts `shared` in A
  assert.equal(a.stats().entries, 1);

  // B writes the same key: a legitimate, fresh entry.
  await (await b.run(keyOf(b, "shared"), async () => ok(111))).done;

  // Any later index write from A runs the merge.
  await (await a.run(keyOf(a, "other"), async () => ok(3))).done;

  const fresh = new ResponseCache({ enabled: true, ttlMs: 600_000, maxEntries: 100, maxBytes: 1 << 20, dir });
  const hit = await fresh.run(keyOf(fresh, "shared"), async () => ok(999));
  assert.equal(hit.hit, true, "A's stale tombstone suppressed B's entry");
  assert.equal(new TextDecoder().decode(hit.payload.body), '{"n":111}', "served a stale body");
});
