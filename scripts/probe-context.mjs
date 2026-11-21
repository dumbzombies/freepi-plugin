#!/usr/bin/env node
// Probe free-pi context limits model by model with oversized single requests.
//
// Each probe is a real, metered turn on a fresh upstream session: the ad cycle
// runs first (same as the plugin), then one non-streaming completion with
// max_tokens=1. A 400/413/422 whose body mentions context/tokens means the
// prompt exceeded the model's window; 200 means it fit.
//
// Usage:
//   node scripts/probe-context.mjs                    # plan only, no requests
//   node scripts/probe-context.mjs --model deepseek-v4.1-flash --at 200000
//   node scripts/probe-context.mjs --all --at 210000 --budget 6000
//   node scripts/probe-context.mjs --all --bisect 160000 220000
//
// Credits: input tokens dominate. A 200k-token probe costs roughly
// 200000 * multiplier * 0.00222 credits (~444 at 1x). Bisect doubles/triples it.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Upstream } from "../src/upstream.ts";
import { EST_CREDITS_PER_TOKEN, DATA_DIR } from "../src/config.ts";

const TOKEN_PATH = process.env.FREEPI_TOKEN_FILE || join(DATA_DIR, "token");
const CHARS_PER_TOKEN = 4;
const MAX_BODY_BYTES = 24 * 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

function filler(tokens) {
  const sentence = "The quick brown fox jumps over the lazy dog. ";
  const need = Math.max(1, Math.round(tokens * CHARS_PER_TOKEN));
  return sentence.repeat(Math.ceil(need / sentence.length)).slice(0, need);
}

function classify(status, text) {
  if (status >= 200 && status < 300) return "fits";
  if (/context[\s_-]*too[\s_-]*long|context[\s_-]*(?:length|window|limit)|maximum context|too many tokens|input.*too long/i.test(text)) return "context";
  if (/session[\s_-]*(?:is[\s_-]*)?too[\s_-]*long|session_too_long|session.*(?:limit|budget|quota|cap)/i.test(text)) return "session";
  if (/ads_required|ad.*required/i.test(text)) return "ads_required";
  if (status === 401) return "auth";
  if (status === 429) return "rate_limited";
  return `http_${status}`;
}

function errorCode(text) {
  try {
    const body = JSON.parse(text);
    return body?.error?.code || body?.code || body?.error?.type || "";
  } catch {
    return "";
  }
}

async function loadToken() {
  if (process.env.FREEPI_TOKEN) return process.env.FREEPI_TOKEN;
  const raw = await readFile(TOKEN_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.token !== "string" || !parsed.token) throw new Error(`no token in ${TOKEN_PATH}`);
  return parsed.token;
}

async function probe(upstream, jwt, model, tokens) {
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: filler(tokens) }],
    stream: false,
    max_tokens: 1,
  });
  if (body.length > MAX_BODY_BYTES) throw new Error(`probe body ${body.length}B exceeds ${MAX_BODY_BYTES}B`);
  upstream.runAdCycle(jwt, sessionId, turnId);
  const res = await upstream.completions(jwt, body, AbortSignal.timeout(180_000), { sessionId, turnId });
  const text = await res.text();
  let usage = null;
  try { usage = JSON.parse(text)?.usage ?? null; } catch { /* error body */ }
  return {
    model,
    requestedTokens: tokens,
    promptTokens: usage?.prompt_tokens ?? null,
    status: res.status,
    verdict: classify(res.status, text),
    code: errorCode(text),
    error: res.ok ? null : text.slice(0, 300).replace(/\s+/g, " "),
  };
}

async function main() {
  const upstream = new Upstream();
  await upstream.refreshCatalog();
  if (!upstream.catalog) throw new Error("could not fetch the catalog");
  const available = upstream.catalog.models.filter((m) => !m.unavailable);

  const all = has("all");
  const selected = [];
  const modelArg = arg("model");
  if (all) selected.push(...available.map((m) => m.id));
  else if (modelArg) selected.push(modelArg);
  else {
    console.log("models:", available.map((m) => m.id).join(", "));
    console.log("\nPlan only. Add --model <id> or --all to probe.");
    const sample = available[0];
    const at = Number(arg("at", 200_000));
    if (sample) {
      const cost = at * sample.multiplier * EST_CREDITS_PER_TOKEN;
      console.log(`Example: --model ${sample.id} --at ${at} → ~${Math.round(cost)} credits`);
    }
    return;
  }

  const at = Number(arg("at", 200_000));
  const bisectLow = arg("bisect") ? Number(process.argv[process.argv.indexOf("--bisect") + 1]) : null;
  const bisectHigh = arg("bisect") ? Number(process.argv[process.argv.indexOf("--bisect") + 2]) : null;
  const budget = Number(arg("budget", 6_000));

  const jwt = await loadToken();
  const catalog = new Map(available.map((m) => [m.id, m]));
  let estimated = 0;
  const results = [];

  const spend = (model, tokens) => {
    const m = catalog.get(model)?.multiplier ?? 1;
    return tokens * m * EST_CREDITS_PER_TOKEN;
  };

  const runProbe = async (model, tokens) => {
    const cost = spend(model, tokens);
    if (estimated + cost > budget) {
      console.error(`budget ${budget} credits reached; stopping at ${model} ${tokens}`);
      return false;
    }
    estimated += cost;
    process.stderr.write(`${model} @ ~${tokens} tokens (~${Math.round(cost)} credits)... `);
    let result;
    try {
      result = await probe(upstream, jwt, model, tokens);
    } catch (e) {
      result = { model, requestedTokens: tokens, promptTokens: null, status: 0, verdict: "client_error", code: "", error: String(e) };
    }
    results.push(result);
    console.log(`${result.verdict}${result.promptTokens ? ` (prompt ${result.promptTokens})` : ""}${result.code ? ` ${result.code}` : ""}`);
    await new Promise((r) => setTimeout(r, 1_000));
    return true;
  };

  for (const model of selected) {
    if (!catalog.has(model)) {
      console.error(`${model}: not in catalog, skipping`);
      continue;
    }
    if (bisectLow != null && bisectHigh != null) {
      let lo = bisectLow;
      let hi = bisectHigh;
      while (hi - lo > 8_000) {
        const mid = Math.round((lo + hi) / 2);
        if (!(await runProbe(model, mid))) return report(results, estimated);
        const last = results[results.length - 1];
        if (last.verdict === "fits") lo = mid;
        else if (last.verdict === "context") hi = mid;
        else break; // session/rate/auth failures are not a window measurement
      }
      console.log(`${model}: observed limit ≈ ${lo}..${hi} tokens`);
      continue;
    }
    if (!(await runProbe(model, at))) return report(results, estimated);
  }
  report(results, estimated);
}


function report(results, estimated) {
  console.log(`\nspent ≈ ${Math.round(estimated ?? 0)} credits`);
  console.log(`${"model".padEnd(40)} ${"req".padStart(7)} ${"prompt".padStart(7)}  verdict`);
  for (const r of results) {
    console.log(`${r.model.padEnd(40)} ${String(r.requestedTokens).padStart(7)} ${String(r.promptTokens ?? "-").padStart(7)}  ${r.verdict}${r.code ? ` ${r.code}` : ""}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  const json = join(DATA_DIR, "context-probe.json");
  void writeFile(json, JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
    .then(() => console.log(`\nwrote ${json}`))
    .catch((e) => console.error(`could not write ${json}: ${e.message}`));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
