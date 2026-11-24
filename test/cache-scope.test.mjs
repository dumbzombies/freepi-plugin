import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freepi-plugin-scope-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");

const { ResponseCache } = await import("../src/cache.ts");

const BODY = '{"model":"m","messages":[{"role":"user","content":"same prompt"}]}';

function upstream(body) {
  return {
    status: 200,
    ctype: "application/json",
    upstream: new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    cacheable: true,
  };
}

/**
 * The disk tier is durable now, so a cache entry outlives the session that
 * created it. One account's paid turn must never be replayed to another
 * account that sends the same prompt.
 */
test("a different credential never receives another account's cached body", async () => {
  const dir = join(home, "cache");
  const opts = { enabled: true, ttlMs: 600_000, maxEntries: 10, maxBytes: 1 << 20, dir };
  const cache = new ResponseCache(opts);

  const tokenA = "aaa.bbb.ccc";
  const tokenB = "ddd.eee.fff";
  const keyA = cache.key(BODY, tokenA);
  const keyB = cache.key(BODY, tokenB);
  assert.notEqual(keyA, keyB, "credentials must not share a cache key");

  await (await cache.run(keyA, async () => upstream('{"for":"A"}'))).done;

  // A fresh instance = a restart; the entry is now on disk.
  const fresh = new ResponseCache(opts);
  const asB = await fresh.run(keyB, async () => upstream('{"for":"B"}'));
  assert.equal(asB.hit, false, "account B was served account A's cached body");
  const bodyB = await new Response(asB.stream).text();
  assert.equal(bodyB, '{"for":"B"}');

  const asA = await fresh.run(keyA, async () => upstream("upstream called again"));
  assert.equal(asA.hit, true);
  assert.equal(new TextDecoder().decode(asA.payload.body), '{"for":"A"}');
});

test("the credential does not appear in the on-disk file name", async () => {
  const dir = join(home, "cache2");
  const cache = new ResponseCache({ enabled: true, ttlMs: 60_000, maxEntries: 10, maxBytes: 1 << 20, dir });
  const token = "secret.token.value";
  const key = cache.key(BODY, token);
  assert.equal(key.includes("secret"), false);
  assert.equal(/^[0-9a-f]{64}$/.test(key), true, "key must be a plain hex digest");
});
