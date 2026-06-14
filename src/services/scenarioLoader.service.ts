import { ALL_SCENARIOS } from "./scenarios";
import { ScenarioContext } from "./geminiAI.service";

const L1_CODE_MAP: Record<string, "ar" | "so" | "fa" | "ti" | "zh"> = {
  arabic: "ar",
  somali: "so",
  dari: "fa",
  pashto: "fa",
  tigrinya: "ti",
  chinese: "zh",
  cantonese: "zh",
  mandarin: "zh",
};

export const loadScenario = (
  scenarioIdOrTopic: string,
  l1Language: string,
): ScenarioContext | undefined => {
  // Match by scenarioId first; fall back to topic matching
  const id = scenarioIdOrTopic.toLowerCase().replace(/\s+/g, "_");
  const direct = ALL_SCENARIOS[id];
  if (!direct) return undefined;

  const l1Lower = (l1Language || "").toLowerCase();
  const l1Code = L1_CODE_MAP[l1Lower] ?? "ar";

  return {
    scenarioId: direct.scenarioId,
    title: direct.title,
    roleplayPrompt: direct.roleplayPrompt,
    grammarTargets: direct.grammarTargets,
    culturalNotes: direct.culturalNotes,
    vocabulary: direct.vocabulary.map((v) => ({
      word: v.word,
      definition: v.definition,
      translations: v.translations as Record<string, string>,
    })),
    passThreshold: direct.passThreshold,
    l1Code,
  };
};

export const listScenarios = () =>
  Object.values(ALL_SCENARIOS).map((s) => ({
    scenarioId: s.scenarioId,
    title: s.title,
    esolLevelRange: s.esolLevelRange,
    skillCodes: s.skillCodes,
  }));
