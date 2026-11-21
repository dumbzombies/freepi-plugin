#!/usr/bin/env node
// Measure whether each model decrements the daily credit allowance.
//
// One fresh, ad-attributed turn per model at a fixed prompt size; then poll
// /me/stats until the request lands and credits settle. A delta of 0 means the
// model did not touch the quota in this probe (free/unlimited); a positive
// delta is the observed credit charge.
//
// Usage:
//   node scripts/probe-billing.mjs --model gpt-6.2-astra --tokens 4000
//   node scripts/probe-billing.mjs --all --tokens 4000 --budget 6000
//   node scripts/probe-billing.mjs --plan

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../src/config.ts";
import { Upstream } from "../src/upstream.ts";

const TOKEN_PATH = process.env.FREEPI_TOKEN_FILE || join(DATA_DIR, "token");
const CHARS_PER_TOKEN = 4;

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

function sleep(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

async function loadToken() {
  if (process.env.FREEPI_TOKEN) return process.env.FREEPI_TOKEN;
  const parsed = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
  if (typeof parsed.token !== "string" || !parsed.token) throw new Error(`no token in ${TOKEN_PATH}`);
  return parsed.token;
}

async function stats(upstream, jwt) {
  const s = await upstream.stats(jwt);
  if (!s) throw new Error("stats unavailable");
  return {
    remaining: s.remaining_credits_today ?? null,
    allowance: s.allowance_credits ?? null,
    requests: s.request_count_today ?? 0,
    promptTokens: s.prompt_tokens_today ?? 0,
    spentUsd: s.spent_usd_today ?? 0,
  };
}

async function main() {
  const upstream = new Upstream();
  await upstream.refreshCatalog();
  if (!upstream.catalog) throw new Error("could not fetch catalog");
  const available = upstream.catalog.models.filter((m) => !m.unavailable);
  const tokens = Number(arg("tokens", 4000));
  const budget = Number(arg("budget", 6000));

  if (!has("all") && !arg("model") && !arg("models") && !has("plan")) {
    console.log("models:");
    for (const m of available) console.log(`  ${m.id} ${m.free ? "(catalog free)" : `(${m.multiplier}x)`}`);
    console.log(`\nPlan only. Add --model <id> or --all. Estimated worst case for --all at ${tokens}:`);
    const worst = available.reduce((n, m) => n + tokens * m.multiplier * 0.00222, 0);
    console.log(`  ${Math.round(worst)} credits (all charged at catalog multiplier)`);
    return;
  }

  const jwt = await loadToken();
  const selected = has("all")
    ? available.map((m) => m.id)
    : (arg("models") ? String(arg("models")).split(",").filter(Boolean) : [arg("model")]);
  const catalog = new Map(available.map((m) => [m.id, m]));
  const results = [];
  let spentEstimate = 0;
  // Reuse one upstream session: fresh sessions per probe exhaust the account's
  // 4 concurrent-session slots (HTTP 409 concurrent_session).
  let sessionId = crypto.randomUUID();

  for (const model of selected) {
    const meta = catalog.get(model);
    if (!meta) {
      console.error(`${model}: not in catalog, skipping`);
      continue;
    }
    const estimate = tokens * meta.multiplier * 0.00222;
    if (spentEstimate + estimate > budget) {
      console.error(`budget ${budget} credits reached; stopping at ${model}`);
      break;
    }
    spentEstimate += estimate;

    const before = await stats(upstream, jwt);
    if (before.remaining == null) throw new Error("stats has no remaining_credits_today");

    const turnId = crypto.randomUUID();
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: filler(tokens) }],
      stream: false,
      max_tokens: 1,
    });
    process.stderr.write(`${model} (~${Math.round(estimate)} credits if charged)... `);
    let status = 0;
    let error = "";
    let promptTokens = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const turnId = crypto.randomUUID();
      status = 0;
      error = "";
      promptTokens = null;
      upstream.runAdCycle(jwt, sessionId, turnId);
      try {
        const res = await upstream.completions(jwt, body, AbortSignal.timeout(180_000), { sessionId, turnId });
        status = res.status;
        const text = await res.text();
        if (!res.ok) error = text.slice(0, 200).replace(/\s+/g, " ");
        else {
          try { promptTokens = JSON.parse(text)?.usage?.prompt_tokens ?? null; } catch { /* ignore */ }
        }
      } catch (e) {
        error = String(e);
      }
      if (!/concurrent_session/.test(error)) break;
      // Slots are held until the previous session leases expire.
      await sleep(15_000);
    }
    if (/session_too_long|context_too_long/.test(error)) sessionId = crypto.randomUUID();

    // Poll until the request is counted and the credit meter settles.
    let after = before;
    for (let i = 0; i < 6; i++) {
      await sleep(2_000);
      after = await stats(upstream, jwt);
      if (after.requests > before.requests && after.remaining < before.remaining) break;
      if (status !== 0 && status !== 200 && after.requests > before.requests) break;
    }

    const delta = before.remaining - after.remaining;
    const observed = status === 200
      ? delta > 0 ? "charged" : "no quota hit"
      : `error ${status}`;
    results.push({
      model,
      catalogFree: meta.free === true,
      multiplier: meta.multiplier,
      requestedTokens: tokens,
      promptTokens,
      status,
      deltaCredits: delta,
      observed,
      error,
    });
    console.log(`${observed} (Δ${delta} credits)`);
    await sleep(1_000);
  }

  console.log(`\n${"model".padEnd(42)} ${"free?".padEnd(7)} ${"mult".padStart(5)} ${"Δcredits".padStart(9)}  observed`);
  for (const r of results) {
    console.log(`${r.model.padEnd(42)} ${String(r.catalogFree).padEnd(7)} ${String(r.multiplier).padStart(5)} ${String(r.deltaCredits).padStart(9)}  ${r.observed}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  const json = join(DATA_DIR, "billing-probe.json");
  await writeFile(json, JSON.stringify({ at: new Date().toISOString(), tokens, results }, null, 2));
  console.log(`\nwrote ${json}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
