import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate settings paths before importing modules that resolve them.
const home = mkdtempSync(join(tmpdir(), "freepi-plugin-settings-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");
process.env.FREEPI_PLUGIN_PORT = "18483";
process.env.FREEPI_BASE_URL = "http://127.0.0.1:1";

const {
  defaultSettings,
  findKey,
  formatValue,
  loadSettings,
  resetSettings,
  saveSettings,
  setSetting,
  SETTINGS_PATH,
} = await import("../src/settings.ts");
const { ResponseCache } = await import("../src/cache.ts");
const { startServer } = await import("../src/server.ts");

test("settings default to env-backed config values", async () => {
  const s = await loadSettings();
  assert.equal(s.port, 18483);
  assert.equal(s.cache.enabled, true);
  assert.deepEqual(s.models.hidden, []);
  assert.equal(SETTINGS_PATH, join(home, "data", "settings.json"));
});

test("invalid values are rejected without touching the file", () => {
  const s = defaultSettings();
  assert.throws(() => setSetting(s, "port", "70000"), /port must be an integer/);
  assert.throws(() => setSetting(s, "cache.enabled", "maybe"), /expected a boolean/);
  assert.throws(() => setSetting(s, "baseUrl", "nope"), /absolute URL/);
  assert.throws(() => setSetting(s, "nope", "1"), /unknown setting/);
});

test("set, save, reload, and reset round-trip", async () => {
  const s = defaultSettings();
  setSetting(s, "cache.maxEntries", "12");
  setSetting(s, "models.hidden", "a, b,a");
  setSetting(s, "ads.gravity", "off");
  await saveSettings(s);

  const loaded = await loadSettings();
  assert.equal(loaded.cache.maxEntries, 12);
  assert.deepEqual(loaded.models.hidden, ["a", "b"]);
  assert.equal(loaded.ads.gravity, false);
  assert.equal(formatValue(findKey("models.hidden"), loaded), "a,b");

  await saveSettings({ ...loaded, port: 19000 });
  assert.equal((await loadSettings()).port, 19000);

  await resetSettings();
  assert.equal((await loadSettings()).port, 18483);
});

test("cache reconfiguration trims entries to the new cap", async () => {
  const cache = new ResponseCache({ enabled: true, ttlMs: 60_000, maxEntries: 10, maxBytes: 1024 * 1024 });
  const source = () => ({
    status: 200,
    ctype: "application/json",
    upstream: new Response("ok"),
    cacheable: true,
  });
  for (const k of ["a", "b", "c"]) {
    const run = await cache.run(k, source);
    await run.done;
  }
  assert.equal(cache.stats().entries, 3);
  cache.configure({ maxEntries: 2 });
  assert.equal(cache.stats().entries, 2);
  cache.configure({ enabled: false });
  const run = await cache.run("d", source);
  assert.equal(run.hit, false);
  assert.equal((await run.done) !== null, true);
});

test("server model list honors freeOnly and hidden", async () => {
  const settings = defaultSettings();
  settings.port = 18491;
  settings.baseUrl = "http://127.0.0.1:1";
  settings.models.freeOnly = true;
  settings.models.hidden = ["hidden-free"];
  const running = await startServer(settings);
  try {
    running.ctx.upstream.catalog = {
      models: [
        { id: "free-a", name: "Free A", free: true, multiplier: 0 },
        { id: "hidden-free", name: "Hidden", free: true, multiplier: 0 },
        { id: "paid-b", name: "Paid B", free: false, multiplier: 4 },
        { id: "gone", name: "Gone", free: true, unavailable: true, multiplier: 0 },
      ],
      latest: "0.6.19",
      min: "0.6.0",
      defaultModel: "free-a",
      fetchedAt: Date.now(),
    };
    const list = await (await fetch(`${running.url}/models`)).json();
    assert.deepEqual(list.data.map((m) => m.id), ["free-a"]);

    running.ctx.settings = { ...settings, models: { ...settings.models, freeOnly: false, hidden: [] } };
    const all = await (await fetch(`${running.url}/models`)).json();
    assert.deepEqual(all.data.map((m) => m.id), ["free-a", "hidden-free", "paid-b"]);
  } finally {
    await running.close();
  }
});
