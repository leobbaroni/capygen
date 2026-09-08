import { UNKNOWN_CONTEXT, type ContextSnapshot } from "@capygen/shared";

const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Latest measured request input; never sum requests or use cumulative model totals. */
export class RequestContext {
  private value: ContextSnapshot = { ...UNKNOWN_CONTEXT };
  snapshot(): ContextSnapshot { return { ...this.value }; }
  capacity(value: unknown): void { const capacity = count(value); if (capacity !== null && capacity > 0) this.value.capacityTokens = capacity; }
  input(value: unknown): void {
    const input = count(value);
    this.value = { ...this.value, inputTokens: input, source: input === null ? "unknown" : "last-request", updatedAt: input === null ? null : Date.now() };
  }
  claude(usage: unknown): void {
    const row = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
    const input = count(row.input_tokens);
    this.input(input === null ? null : input + (count(row.cache_read_input_tokens) ?? 0) + (count(row.cache_creation_input_tokens) ?? 0));
  }
  api(usage: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): void {
    this.input(usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens);
  }
}
