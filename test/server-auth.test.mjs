import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate paths and keep the catalog fetch off the network before importing.
const home = mkdtempSync(join(tmpdir(), "freepi-plugin-auth-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");
process.env.FREEPI_PLUGIN_PORT = "18560";

const { startServer } = await import("../src/server.ts");
const { defaultSettings } = await import("../src/settings.ts");
const { saveToken } = await import("../src/token.ts");

const JWT = `x.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")}.y`;

test("a placeholder api key falls back to the stored token instead of 401", async () => {
  // Hosts such as opencode require a non-empty apiKey in their provider config.
  // The loopback server must treat that string as "use the token file", not as
  // a credential, and must not leak it upstream.
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [], usage: {} }));
    });
  });
  await new Promise((r) => upstream.listen(19601, "127.0.0.1", r));
  const running = await startServer({ ...defaultSettings(), baseUrl: "http://127.0.0.1:19601" });
  await saveToken(JWT);
  try {
    const url = `http://127.0.0.1:${running.port}/v1/chat/completions`;
    for (const [i, headers] of [
      { authorization: "Bearer freepi" },
      { authorization: `Bearer ${JWT}` },
      {},
    ].entries()) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        // distinct bodies: the exact-response cache would otherwise serve the
        // second and third requests without touching upstream
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: String(i) }] }),
      });
      assert.equal(res.status, 200, `headers ${JSON.stringify(headers)}`);
    }
    assert.deepEqual(seen, [`Bearer ${JWT}`, `Bearer ${JWT}`, `Bearer ${JWT}`]);
  } finally {
    await running.close();
    upstream.close();
  }
});
