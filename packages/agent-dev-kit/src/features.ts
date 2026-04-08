import type { AgentFeatures } from "./types.js";

export const FEATURE_NAMES = ["memory", "triologue", "skills"] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

const FEATURE_SET = new Set<FeatureName>(FEATURE_NAMES);

export function createEmptyFeatureSelection(): AgentFeatures {
  return {
    memory: false,
    triologue: false,
    skills: false,
  };
}

export function parseFeatureFlags(input?: string): AgentFeatures {
  const features = createEmptyFeatureSelection();

  if (!input || input.trim() === "") {
    return features;
  }

  const parsedValues = input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const invalidValues = parsedValues.filter(
    (value): value is string => !FEATURE_SET.has(value as FeatureName),
  );

  if (invalidValues.length > 0) {
    const uniqueInvalidValues = [...new Set(invalidValues)];
    throw new Error(
      `Unknown features: ${uniqueInvalidValues.join(", ")}. Allowed features: ${FEATURE_NAMES.join(", ")}.`,
    );
  }

  const uniqueFeatures = new Set(parsedValues as FeatureName[]);

  for (const feature of uniqueFeatures) {
    features[feature] = true;
  }

  return features;
}
