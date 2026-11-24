import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freepi-plugin-concurrent-"));
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
 * The disk tier is shared by the omp in-process server and the opencode
 * service. Two writers finishing in the same tick must both persist: the index
 * merge has to be serialized, not read-modify-written in parallel (which loses
 * whichever entry was read before the other's rename).
 */
test("two writers storing concurrently both survive a restart", async () => {
  const dir = join(home, "cache");
  const opts = { enabled: true, ttlMs: 600_000, maxEntries: 100, maxBytes: 1 << 20, dir };
  const a = new ResponseCache(opts);
  const b = new ResponseCache(opts);
  const keyOf = (cache, text) => cache.key(`{"model":"m","messages":[{"role":"user","content":"${text}"}]}`);

  await Promise.all([
    a.run(keyOf(a, "one"), async () => ok(1)).then((r) => r.done),
    b.run(keyOf(b, "two"), async () => ok(2)).then((r) => r.done),
    a.run(keyOf(a, "three"), async () => ok(3)).then((r) => r.done),
  ]);

  const fresh = new ResponseCache(opts);
  for (const text of ["one", "two", "three"]) {
    const hit = await fresh.run(keyOf(fresh, text), async () => ok(0));
    assert.equal(hit.hit, true, `entry "${text}" was lost by a concurrent index write`);
  }
});
