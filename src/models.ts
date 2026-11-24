// Host-neutral model view. Both the pi/omp extension and the opencode plugin
// map free-pi's live catalog to their own provider shapes from this.

import type { Catalog, CatalogModel } from "./upstream.ts";
import { isModelVisible } from "./visibility.ts";
import type { Settings } from "./settings.ts";

export interface NeutralModel {
  id: string;
  name: string;
  free: boolean;
  multiplier: number | undefined;
  contextWindow: number;
  maxTokens: number;
}

/** Last-resort list when the public catalog cannot be fetched at load time. */
const FALLBACK_IDS: Array<[string, string]> = [
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["glm-5.3-flash", "GLM 5.3 Flash"],
  ["particle", "Particle"],
];

export function visibleCatalogModels(catalog: Catalog | null, settings: Settings): CatalogModel[] {
  return (catalog?.models ?? []).filter((m) => isModelVisible(m, settings));
}

/** Catalog order, filtered by settings; free models sorted first. */
export function providerModels(catalog: Catalog | null, settings: Settings): NeutralModel[] {
  const available = visibleCatalogModels(catalog, settings);
  const map = (m: CatalogModel): NeutralModel => ({
    id: m.id,
    name: (m.display_name || m.name.split(" · ")[0]?.trim() || m.id) + (m.free ? " (free)" : ""),
    free: m.free === true,
    multiplier: m.multiplier,
    contextWindow: settings.models.contextWindow,
    maxTokens: settings.models.maxTokens,
  });
  if (available.length > 0) return available.map(map);
  // Every fallback model is in the free bucket, so models.freeOnly keeps them all.
  return FALLBACK_IDS
    .filter(([id]) => !settings.models.hidden.includes(id))
    .map(([id, name]) => ({
      id,
      name,
      free: true,
      multiplier: undefined,
      contextWindow: settings.models.contextWindow,
      maxTokens: settings.models.maxTokens,
    }));
}
