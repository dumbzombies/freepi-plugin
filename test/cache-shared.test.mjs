import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two servers share ~/.freepi-plugin/cache (omp in-process + opencode service),
// so a write from one must not erase the other's entries.
const home = mkdtempSync(join(tmpdir(), "freepi-plugin-shared-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");

const { ResponseCache } = await import("../src/cache.ts");

const opts = (dir) => ({ enabled: true, ttlMs: 60_000, maxEntries: 10, maxBytes: 1 << 20, dir });

function upstream(body) {
  return {
    status: 200,
    ctype: "application/json",
    upstream: new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    cacheable: true,
  };
}

test("concurrent writers keep each other's entries", async () => {
  const dir = join(home, "shared");
  const a = new ResponseCache(opts(dir));
  const b = new ResponseCache(opts(dir));

  const keyMine = a.key('{"model":"m","messages":[{"role":"user","content":"mine"}]}');
  const keyTheirs = b.key('{"model":"m","messages":[{"role":"user","content":"theirs"}]}');

  await (await a.run(keyMine, async () => upstream('{"from":"a"}'))).done;
  // b loaded the index before a wrote; its write must merge, not replace.
  await (await b.run(keyTheirs, async () => upstream('{"from":"b"}'))).done;

  const fresh = new ResponseCache(opts(dir));
  for (const [key, expected] of [[keyMine, '{"from":"a"}'], [keyTheirs, '{"from":"b"}']]) {
    const hit = await fresh.run(key, async () => upstream("upstream called"));
    assert.equal(hit.hit, true, `missing entry ${expected}`);
    assert.equal(new TextDecoder().decode(hit.payload.body), expected);
  }
});
