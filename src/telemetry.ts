// Upstream prompt-cache telemetry.
//
// free-pi reports `usage.prompt_tokens_details.cached_tokens` on every
// completion. That number is the only honest measure of whether the provider
// side reused a prompt prefix, so the server accumulates it and exposes the
// ratio next to the local response-cache stats.

export interface PromptCacheStats {
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  /** cachedTokens / promptTokens; 0 until the first completion lands. */
  hitRate: number;
}

/** Last `max` ratios, oldest first: a rolling view for `/freepi server`. */
export class PromptCacheMeter {
  private requests = 0;
  private promptTokens = 0;
  private cachedTokens = 0;
  private readonly max: number;
  private readonly recent: Array<{ prompt: number; cached: number }>;

  constructor(max = 64) {
    this.max = max;
    this.recent = [];
  }

  /** Extract prompt-cache usage from a completion body, JSON or SSE. */
  record(raw: Uint8Array): void {
    const usage = extractUsage(new TextDecoder().decode(raw));
    if (!usage) return;
    const prompt = usage.prompt_tokens ?? 0;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    if (prompt <= 0) return;
    this.requests++;
    this.promptTokens += prompt;
    this.cachedTokens += Math.min(cached, prompt);
    this.recent.push({ prompt, cached });
    if (this.recent.length > this.max) this.recent.shift();
  }

  stats(): PromptCacheStats {
    return {
      requests: this.requests,
      promptTokens: this.promptTokens,
      cachedTokens: this.cachedTokens,
      hitRate: this.promptTokens ? this.cachedTokens / this.promptTokens : 0,
    };
  }
}

interface Usage {
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * The usage block arrives once: in the final `data:` event for streams, or at
 * the top level for JSON. Scan from the end so a long stream costs one pass.
 */
function extractUsage(text: string): Usage | null {
  const marker = '"usage"';
  const at = text.lastIndexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf("{", at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as Usage;
      } catch {
        return null;
      }
    }
  }
  return null;
}
