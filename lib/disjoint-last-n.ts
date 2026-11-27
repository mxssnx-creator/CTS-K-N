import {blockPolicyKey,blockRequired,checkBlockPolicy,type BlockPolicy} from "@/shared/cts-lastn/blocks";

export const DEFAULT_AUTO_PF_RATIO = 4;
export function normalizeStageAutoPfRatio(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_AUTO_PF_RATIO;
  const ratio = typeof value === "string" ? Number(value) : value;
  if (typeof ratio !== "number" || !Number.isInteger(ratio) || ratio < 1 || ratio > 10)
    throw new Error("Auto PF ratio must be a whole number from 1 to 10");
  return ratio;
}

export type StageLongMode = "configured" | "inherit" | "none" | "both";
type StageBlockPolicy = BlockPolicy & { longMode?: StageLongMode };
export type StageBlockPolicies = Partial<Record<"base" | "main" | "real" | "live", StageBlockPolicy>>;
export type StageBlocks = BlockPolicy | readonly BlockPolicy[];

export function stageBlockPolicies(raw: unknown): StageBlockPolicies {
  if (raw == null || raw === "") return {};
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Last-N block policies");
  const out: StageBlockPolicies = {};
  for (const [stage, candidate] of Object.entries(value)) {
    if (!["base", "main", "real", "live"].includes(stage)) throw new Error("Unknown Last-N stage");
    const policy = candidate as StageBlockPolicy;
    checkBlockPolicy(policy);
    const mode = policy.longMode;
    if (mode !== undefined && (stage === "base" || !["configured", "inherit", "none", "both"].includes(mode)))
      throw new Error("Invalid stage Long mode");
    out[stage as keyof StageBlockPolicies] = {...policy};
  }
  for (const stage of ["main", "real", "live"] as const) stageBlockChoices(out, stage);
  return out;
}

export function stageBlockChoices(policies: StageBlockPolicies, stage: keyof StageBlockPolicies): StageBlocks | undefined {
  const policy = policies[stage];
  if (!policy) return undefined;
  const { longMode, ...block } = policy;
  if (!longMode || longMode === "configured") return block;
  const inherited = policies.base?.long ?? 0;
  if (longMode !== "none" && !inherited) throw new Error("Configure Base Long before inheriting it");
  const choices = longMode === "both" ? [inherited, 0] : [longMode === "inherit" ? inherited : 0];
  const blocks = choices.map(long => ({ ...block, long }));
  blocks.forEach(checkBlockPolicy);
  return blocks.length > 1 ? blocks : blocks[0];
}

export function longAlternatives(blocks: StageBlocks): readonly BlockPolicy[] {
  return "long" in blocks ? [blocks] : blocks;
}

export function stageBlockRevision(policies: StageBlockPolicies): string[][] {
  return (["base", "main", "real", "live"] as const).flatMap(stage => {
    const blocks = stageBlockChoices(policies, stage);
    return blocks ? [[stage, ...longAlternatives(blocks).map(blockPolicyKey)]] : [];
  });
}

export function stageBlockRetention(blocks: StageBlocks, calibration: number): number {
  return Math.max(...longAlternatives(blocks).map(policy =>
    blockRequired(policy) + (policy.autoPfRatio === undefined ? 0 : calibration)));
}
