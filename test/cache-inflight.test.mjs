import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freepi-plugin-inflight-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");

const { ResponseCache } = await import("../src/cache.ts");

const opts = { enabled: true, ttlMs: 60_000, maxEntries: 10, maxBytes: 1 << 20, dir: null };

function ok(body) {
  return {
    status: 200,
    ctype: "application/json",
    upstream: new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    cacheable: true,
  };
}

/**
 * A caller that parks on another caller's in-flight request must receive that
 * caller's *result*. If the producer returned an error body (cacheable: false),
 * the follower must get the same error — not a fabricated cache hit.
 */
test("an in-flight follower never receives an uncacheable error body as a hit", async () => {
  const cache = new ResponseCache(opts);
  const key = cache.key('{"model":"m","messages":[]}');

  let release;
  const gate = new Promise((r) => (release = r));
  let first = true;
  const produce = async () => {
    if (first) {
      first = false;
      await gate;
      return {
        status: 500,
        ctype: "application/json",
        upstream: new Response('{"error":"upstream exploded"}', { status: 500 }),
        cacheable: false,
      };
    }
    return ok('{"ok":true}');
  };

  const a = cache.run(key, produce);
  const b = cache.run(key, produce);
  release();
  const [ra, rb] = await Promise.all([a, b]);

  assert.equal(ra.hit, false);
  assert.equal(rb.hit, false, "follower reported a cache hit for an error response");
  // The follower must re-fetch rather than inherit the leader's failure body.
  assert.equal(rb.status, 200);
  // and nothing was stored
  assert.equal(cache.stats().entries, 0, "an uncacheable response was stored");
});
