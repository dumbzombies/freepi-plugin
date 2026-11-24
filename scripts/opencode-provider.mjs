// Prints the opencode provider block for freepi, with models from the live
// free-pi catalog filtered exactly like the omp provider list. opencode reads
// provider settings only from config, so this is the wiring step:
//
//   node scripts/opencode-provider.mjs         # inspect
//   node scripts/opencode-provider.mjs --json  # machine-readable
//
// Paste the object under `provider.freepi` in ~/.config/opencode/opencode.jsonc.

import { loadSettings } from "../src/settings.ts";
import { providerModels } from "../src/models.ts";
import { Upstream } from "../src/upstream.ts";

const settings = await loadSettings();
const catalog = await new Upstream(settings.baseUrl).refreshCatalog();
const models = providerModels(catalog, settings);

const block = {
  name: "Free Pi",
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: `http://127.0.0.1:${settings.port}/v1`, apiKey: "freepi" },
  models: Object.fromEntries(models.map((m) => [m.id, {
    name: m.name,
    reasoning: true,
    attachment: false,
    tool_call: true,
    limit: { context: m.contextWindow, output: m.maxTokens },
    cost: { input: 0, output: 0 },
  }])),
};

process.stdout.write(JSON.stringify(block, null, 2) + "\n");
