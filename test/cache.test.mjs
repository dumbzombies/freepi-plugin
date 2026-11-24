import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freepi-plugin-cache-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");

const { ResponseCache } = await import("../src/cache.ts");

const opts = (dir) => ({ enabled: true, ttlMs: 60_000, maxEntries: 10, maxBytes: 1 << 20, dir });

function upstream(body, ctype = "application/json") {
  return {
    status: 200,
    ctype,
    upstream: new Response(body, { status: 200, headers: { "content-type": ctype } }),
    cacheable: true,
  };
}

const BODY = 'data: {"choices":[],"usage":{"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":9}}}\n\n';

test("equivalent request bodies share one cache key", () => {
  const cache = new ResponseCache(opts(null));
  // key order, whitespace, and an explicit stream:false change nothing
  const a = cache.key('{"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0}');
  const b = cache.key('{ "temperature": 0, "messages": [ {"content":"hi","role":"user"} ], "model":"m" }');
  const c = cache.key('{"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0,"stream":false,"stream_options":{"include_usage":true}}');
  assert.equal(a, b);
  assert.equal(a, c);
  // streaming changes the response format, so it must not collide
  assert.notEqual(a, cache.key('{"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0,"stream":true}'));
  // a different prompt must not collide
  assert.notEqual(a, cache.key('{"model":"m","messages":[{"role":"user","content":"ho"}],"temperature":0}'));
});

test("hits are served from a second process through the disk tier", async () => {
  const dir = join(home, "shared-cache");
  const key = new ResponseCache(opts(dir)).key('{"model":"m","messages":[]}');

  let calls = 0;
  const first = new ResponseCache(opts(dir));
  const run = await first.run(key, async () => {
    calls++;
    return upstream(BODY, "text/event-stream");
  });
  assert.equal(run.hit, false);
  await run.done;
  assert.equal(calls, 1);

  // a fresh instance (new process, same data dir) answers without upstream
  const second = new ResponseCache(opts(dir));
  const replay = await second.run(key, async () => {
    calls++;
    return upstream("nope");
  });
  assert.equal(replay.hit, true);
  assert.equal(replay.layer, "disk");
  assert.equal(new TextDecoder().decode(replay.payload.body), BODY);
  assert.equal(calls, 1);
  assert.equal(second.stats().hits, 1);
  assert.equal(second.stats().savedBytes, BODY.length);
});

test("memory hits are labelled and counted separately from disk hits", async () => {
  const cache = new ResponseCache(opts(null));
  const key = cache.key('{"model":"m","messages":[]}');
  const run = await cache.run(key, async () => upstream(BODY));
  await run.done;
  const hit = await cache.run(key, async () => upstream("nope"));
  assert.equal(hit.layer, "memory");
  assert.equal(cache.stats().hitRate, 0.5);
});

test("an expired disk entry is not served", async () => {
  const dir = join(home, "expiring-cache");
  let clock = 1_000;
  const now = () => clock;
  const first = new ResponseCache({ ...opts(dir), now });
  const key = first.key('{"model":"m","messages":[]}');
  await (await first.run(key, async () => upstream(BODY))).done;

  clock += 120_000;
  const second = new ResponseCache({ ...opts(dir), now });
  const replay = await second.run(key, async () => upstream(BODY));
  assert.equal(replay.hit, false);
});
