import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An entry evicted for exceeding the byte cap must not come back when the index
// merge runs, and its body must not be served afterwards.
const home = mkdtempSync(join(tmpdir(), "freepi-plugin-evict-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");

const { ResponseCache } = await import("../src/cache.ts");

function upstream(bytes) {
  const body = new Uint8Array(bytes).fill(120);
  return {
    status: 200,
    ctype: "application/json",
    upstream: new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    cacheable: true,
  };
}

const key = (cache, text) => cache.key(`{"model":"m","messages":[{"role":"user","content":"${text}"}]}`);

test("an entry evicted by the byte cap is not resurrected by the index merge", async () => {
  const dir = join(home, "shared");
  const opts = { enabled: true, ttlMs: 60_000, maxEntries: 10, maxBytes: 1000, dir };
  const a = new ResponseCache(opts);
  const b = new ResponseCache(opts);

  const first = key(a, "a");
  await (await a.run(first, async () => upstream(800))).done;
  // Second 800-byte entry cannot fit next to the first: one is evicted.
  await (await b.run(key(b, "b"), async () => upstream(800))).done;
  assert.equal(a.stats().bytes <= 1000, true, "cache exceeded its byte cap");

  const fresh = new ResponseCache(opts);
  assert.equal(fresh.stats().bytes <= 1000, true, "reloaded cache exceeded its byte cap");
});
