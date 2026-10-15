import type { ModelView } from "./agentIpc";

/** Product tiers are presentation names; engine identifiers stay internal. */
export function agentTier(model: Pick<ModelView, "totalParamsB" | "sizeBytes">): string {
  if (model.totalParamsB > 100) return model.sizeBytes > 70_000_000_000 ? "Max+" : "Max";
  if (model.totalParamsB > 4) return model.sizeBytes > 22_000_000_000 ? "Pro+" : "Pro";
  return model.sizeBytes > 3_500_000_000 ? "Lite+" : "Lite";
}

export function agentName(model: Pick<ModelView, "totalParamsB" | "sizeBytes">): string {
  return `OpenMindAI Agent · ${agentTier(model)}`;
}
