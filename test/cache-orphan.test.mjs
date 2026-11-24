import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freepi-plugin-orphan-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");

const { ResponseCache } = await import("../src/cache.ts");

function ok(body = '{"ok":1}') {
  return {
    status: 200,
    ctype: "application/json",
    upstream: new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    cacheable: true,
  };
}

/**
 * Expired entries must release their bodies. With a shared disk tier this is
 * the only thing preventing unbounded growth in ~/.freepi-plugin/cache, since
 * nothing prunes files that the index no longer references.
 */
test("expired entries delete their body files from the disk tier", async () => {
  const dir = join(home, "cache");
  rmSync(dir, { recursive: true, force: true });
  let clock = 1_000_000;
  const now = () => clock;
  const opts = { enabled: true, ttlMs: 1_000, maxEntries: 10, maxBytes: 1 << 20, dir, now };

  const first = new ResponseCache(opts);
  for (let i = 0; i < 5; i++) {
    const key = first.key(`{"model":"m","messages":[{"role":"user","content":"${i}"}]}`);
    await (await first.run(key, async () => ok())).done;
  }
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".bin")).length, 5);

  clock += 5_000; // every entry is now expired
  const second = new ResponseCache(opts);
  const key = second.key('{"model":"m","messages":[{"role":"user","content":"new"}]}');
  await (await second.run(key, async () => ok())).done;

  const bins = readdirSync(dir).filter((f) => f.endsWith(".bin"));
  assert.equal(bins.length, 1, `orphaned bodies left behind: ${bins.length}`);
});
