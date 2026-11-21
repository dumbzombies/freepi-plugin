import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate paths and keep the catalog fetch off the network before importing.
const home = mkdtempSync(join(tmpdir(), "freepi-plugin-test-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");
process.env.FREEPI_BASE_URL = "http://127.0.0.1:1";
process.env.FREEPI_PLUGIN_PORT = "18473";

const { startServer } = await import("../src/server.ts");
const { tokenExpiry } = await import("../src/token.ts");

test("tokenExpiry reads the JWT exp claim", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url");
  assert.equal(tokenExpiry(`x.${payload}.y`), 2_000_000_000_000);
  assert.equal(tokenExpiry("not-a-jwt"), null);
});

test("embedded server answers health, models, and gates without a token", async () => {
  const running = await startServer();
  try {
    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const models = await fetch(`${running.url}/models`);
    assert.equal(models.status, 200);
    const list = await models.json();
    assert.equal(list.object, "list");
    assert.ok(Array.isArray(list.data));

    const completion = await fetch(`${running.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    assert.equal(completion.status, 401);
    assert.equal((await completion.json()).error.code, "no_token");

    const quota = await fetch(`http://127.0.0.1:${running.port}/v1/quota`);
    assert.equal(quota.status, 401);
  } finally {
    await running.close();
  }
});
