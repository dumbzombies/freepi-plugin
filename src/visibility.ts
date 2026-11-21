// Model visibility. Catalog models that need purchased premium credits return
// 403 model_requires_credits, so they are hidden unless models.showPremium is on.
// The multiplier rule covers every 1x+ model; the explicit set covers observed
// sub-1x premium-only outliers.

import type { CatalogModel } from "./upstream.ts";
import type { Settings } from "./settings.ts";

const PREMIUM_ONLY_IDS: Record<string, true> = {
  "abliterated-large-flash": true,
  "abliterated-large-v2": true,
  "deepseek-v4.1-flash-1017-ultrafast": true,
  "deepseek-v4.1-flash-abliterated": true,
  "deepseek-v4-pro": true,
  "gemini-4-carbon": true,
  "gemini-4-hydrogen": true,
  "gemini-4-neon": true,
  "gemma-4-uncensored": true,
  "glm-4.7-flash-heretic": true,
  "gpt-6.2-astra": true,
  "kimi-k3.1-pro": true,
  "mimo-v2.6-flash": true,
  "qwen3.5-35b-darkbloom": true,
  "qwen3.6-plus-uncensored": true,
  "solar-pro-4": true,
  "uncensored-1.2": true,
};

export function isPremiumOnly(m: CatalogModel): boolean {
  return m.free !== true && (m.multiplier >= 1 || PREMIUM_ONLY_IDS[m.id] === true);
}

export function isModelVisible(m: CatalogModel, settings: Settings): boolean {
  if (m.unavailable) return false;
  if (settings.models.hidden.includes(m.id)) return false;
  if (settings.models.freeOnly && m.free !== true) return false;
  if (!settings.models.showPremium && isPremiumOnly(m)) return false;
  return true;
}
