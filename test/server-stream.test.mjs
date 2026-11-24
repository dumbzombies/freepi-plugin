import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freepi-plugin-stream-"));
process.env.HOME = home;
process.env.FREEPI_PLUGIN_DATA_DIR = join(home, "data");
process.env.FREEPI_PLUGIN_PORT = "18502";
// Must be set before src/config.ts is imported: the module reads it at load.
process.env.FREEPI_BASE_URL = "http://127.0.0.1:19997";

const { startServer } = await import("../src/server.ts");
const { saveToken } = await import("../src/token.ts");

test("upstream stream error terminates the client response (no hang)", async () => {
  // Upstream answers 200 + SSE headers, writes one event, then kills the socket
  // without ending the response: the client must not hang on a dead stream.
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/client-version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ min: "0.6.19", latest: "0.6.19", model: "m", models: [] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {\"partial\":true}\n\n");
        setTimeout(() => res.destroy(), 150);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => upstream.listen(19997, "127.0.0.1", r));
  await saveToken("jwt-test");
  const running = await startServer();
  try {
    const url = `http://127.0.0.1:${running.port}/v1/chat/completions`;
    const outcome = await new Promise((resolve) => {
      const req = http.request(url, {
        method: "POST",
        headers: { authorization: "Bearer jwt-test", "content-type": "application/json" },
      }, (res) => {
        res.resume();
        res.once("end", () => resolve("ended"));
        res.once("close", () => resolve("closed"));
      });
      req.on("error", () => resolve("errored"));
      req.end(JSON.stringify({ model: "m", messages: [] }));
      setTimeout(() => resolve("HUNG"), 4000);
    });
    assert.notEqual(outcome, "HUNG", `client hung waiting for stream end (got: ${outcome})`);
  } finally {
    await running.close();
    upstream.close();
  }
});
