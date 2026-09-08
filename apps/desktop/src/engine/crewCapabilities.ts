import type { CrewCapability, HarnessInfo } from "@capygen/shared";

/** Metadata only. Unknown API effort support stays unavailable rather than guessed. */
export function crewCapabilities(harnesses: readonly HarnessInfo[]): CrewCapability[] {
  return harnesses.filter((harness) => harness.available).flatMap((harness) =>
    harness.models.map((model) => ({
      backend: harness.backend,
      model: model.id,
      efforts: model.efforts ?? [],
      ...(model.providers ? { providers: model.providers } : {}),
    })));
}
