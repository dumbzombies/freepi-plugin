// Quota rendering shared by the pi/omp extension and the opencode plugin.

import type { QuotaView } from "./state.ts";

export function formatCredits(n: number | null): string {
  if (n == null) return "?";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "unknown";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

export function renderQuota(view: QuotaView, fallbackHandle?: string): string {
  const handle = view.handle ?? fallbackHandle;
  const head = ["free-pi", handle ? `@${handle}` : null, view.tier].filter(Boolean).join(" · ");
  if (!view.ok) {
    return `${head}\nQuota unavailable: ${view.error ?? "no stats returned"}. Check your connection and try again.`;
  }
  const q = view.quota;
  const lines = [
    head,
    `Credits: ${formatCredits(q.remaining_credits_today)} / ${formatCredits(q.allowance_credits)} left (${q.remaining_pct ?? "?"}%)`,
    `Used today: ${formatCredits(q.used_credits_today)} credits · $${q.spent_usd_today ?? "?"} of $${q.cap_usd_today ?? "?"}`,
    `Requests today: ${view.usage.requests_today ?? "?"} · tokens ${view.usage.prompt_tokens_today ?? "?"} in / ${view.usage.completion_tokens_today ?? "?"} out`,
    `Refills in ${formatDuration(q.refill_in_ms)}${q.refill_at ? ` (${q.refill_at})` : ""}`,
  ];
  if (view.promptCache.requests > 0) {
    const pct = Math.round(view.promptCache.hitRate * 1000) / 10;
    lines.push(`Prompt cache: ${pct}% of ${view.promptCache.promptTokens} tokens reused upstream`);
  }
  if (view.cache.hits > 0) {
    const pct = Math.round(view.cache.hitRate * 1000) / 10;
    lines.push(`Response cache: ${view.cache.hits} hits / ${view.cache.misses} misses (${pct}%)`);
  }
  if (view.notice) lines.push(`Notice: ${view.notice}`);
  if (view.usage.streak_days != null) lines.push(`Streak: ${view.usage.streak_days} day(s)`);
  return lines.join("\n");
}
