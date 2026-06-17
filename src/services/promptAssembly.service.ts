import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

import ApiError from "../errors/apiError";
import { EsolLevel } from "../interfaces/placementQuestion.interface";
import logger from "../config/logger";

/**
 * Six-layer system prompt assembly — brief Function 7 To-Do 1.
 *
 * Concatenation order at the wire:
 *   1 → 2 → 3 → 4 → 6 → 5
 *
 * The cacheable spine (1+2+3+4+6) is identical across every turn for
 * a given (level, scenario) combination. The dynamic per-session
 * Layer 5 is computed at call time and appended after the cache hit.
 * Vertex AI's `cachedContents` resource holds the spine; Layer 5
 * rides as the inline user-message preamble.
 *
 * See src/data/system-prompts/README.md for the editorial protocol.
 */

// ─────────────────────────────────────────────────────────────────────
// Filesystem loaders (cached for process lifetime)
// ─────────────────────────────────────────────────────────────────────

const PROMPT_DIR = resolve(__dirname, "../data/system-prompts");
// Layer 2 (hard rules) + Layer 3 (level calibration) are the curriculum
// task's machine output — the AI Tutor Brief is emphatic that we use its
// EXACT text and never paraphrase. So they're built from this JSON, not
// from hand-edited .md files (which would drift). Layer 1 (identity) and
// Layer 6 (output format) remain editorial .md.
const SPEC_PATH = resolve(
  __dirname,
  "../data/curriculum/system_prompt_spec.json",
);

interface LayerCache {
  layer1: string;
  layer2: string;
  layer6: string;
  layer3: Map<EsolLevel, string>;
}

let _cache: LayerCache | null = null;

/**
 * Strip HTML comments. The MD files use `<!-- … -->` for editorial
 * notes that should not reach Gemini. Anything between those markers
 * is removed before assembly.
 */
const stripHtmlComments = (md: string): string =>
  md.replace(/<!--[\s\S]*?-->/g, "").trim();

const readLayer = (relativePath: string): string => {
  const fullPath = resolve(PROMPT_DIR, relativePath);
  const raw = readFileSync(fullPath, "utf8");
  return stripHtmlComments(raw);
};

interface SystemPromptSpec {
  layer_2_hard_rules: Record<string, string>;
  layer_3_level_calibration: Record<
    string,
    {
      nqf_level: string;
      cefr: string;
      response_length_cap: string;
      l1_ratio_instruction: string;
      grammar_instruction: string;
      vocabulary_instruction: string;
      question_types: string;
      sentence_complexity_ceiling: string;
      recast_instruction: string;
      anchor_triggers: string;
      immersion_triggers: string;
    }
  >;
}

/** Build the Layer 2 hard-rules block verbatim from the spec, in file
 *  order (the advice guardrail sits first). */
const buildLayer2FromSpec = (spec: SystemPromptSpec): string => {
  const rules = Object.values(spec.layer_2_hard_rules)
    .map((r) => `- ${r}`)
    .join("\n");
  return `# Layer 2 — Hard Rules\n\nThese rules apply at every level and override anything below.\n\n${rules}`;
};

/** Build a level's Layer 3 calibration block verbatim from the spec. */
const buildLayer3FromSpec = (
  spec: SystemPromptSpec,
  levelUpper: string,
): string | null => {
  const c = spec.layer_3_level_calibration[levelUpper];
  if (!c) return null;
  return `# Layer 3 — Level Calibration (${c.nqf_level} / CEFR ${c.cefr})

- Response length: ${c.response_length_cap}
- First-language ratio: ${c.l1_ratio_instruction}
- Grammar: ${c.grammar_instruction}
- Vocabulary: ${c.vocabulary_instruction}
- Question types: ${c.question_types}
- Sentence complexity: ${c.sentence_complexity_ceiling}
- Corrective feedback: ${c.recast_instruction}
- Lean on more first language when: ${c.anchor_triggers}
- Move toward more English when: ${c.immersion_triggers}`;
};

const loadLayers = (): LayerCache => {
  if (_cache) return _cache;

  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as SystemPromptSpec;

  const layer3 = new Map<EsolLevel, string>();
  for (const level of ["e1", "e2", "e3", "l1", "l2"] as EsolLevel[]) {
    const built = buildLayer3FromSpec(spec, level.toUpperCase());
    if (!built) {
      throw new ApiError(
        500,
        `system_prompt_spec.json has no layer_3 calibration for "${level.toUpperCase()}"`,
      );
    }
    layer3.set(level, built);
  }

  _cache = {
    layer1: readLayer("layer1-identity.md"),
    layer2: buildLayer2FromSpec(spec),
    layer6: readLayer("layer6-output-format.md"),
    layer3,
  };
  logger.info(
    {
      layer1Chars: _cache.layer1.length,
      layer2Chars: _cache.layer2.length,
      layer6Chars: _cache.layer6.length,
      layer3Entries: _cache.layer3.size,
      source: "layer2+3 from system_prompt_spec.json",
    },
    "Prompt layers loaded",
  );
  return _cache;
};

/** Exposed for tests that mutate disk between cases. */
export const __resetPromptCache = () => {
  _cache = null;
};

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export interface LearnerProfileForPrompt {
  esolLevel: EsolLevel;
  l1Language: string;
  vocabularyToReinforce: string[];
  recentSessionSummaries: string[];
  skillWeaknessFlags: string[];
  currentMode: "BRIDGE" | "ANCHOR" | "IMMERSION";
  advancementCeremony?: { toLevel: string } | null;
}

export interface ScenarioForPrompt {
  scenarioId: string;
  title: string;
  roleplayPrompt: string;
  grammarTargets: string[];
  culturalNotes: string;
  passThreshold: number;
  vocabulary: Array<{
    word: string;
    definition?: string;
    translations?: Record<string, string>;
  }>;
  l1Code?: string;
}

export interface AssembledPrompt {
  /**
   * Full prompt as Gemini will receive it (with Layer 5 inlined).
   * Useful for logging + local testing without the Vertex cache.
   */
  systemPrompt: string;
  /**
   * The cacheable spine: layers 1, 2, 3, 4, 6 concatenated. This is
   * what gets uploaded to Vertex's `cachedContents` resource.
   */
  cacheableLayers: string;
  /**
   * Layer 5 only — the per-session learner profile. Sent as the
   * user-message preamble on each call, never cached.
   */
  dynamicLayer: string;
  /**
   * Stable hash of the cacheable spine. Use as the lookup key for
   * the Vertex cache: same hash → reuse the cached_content resource;
   * different hash → create a new one.
   */
  cacheKey: string;
  /**
   * Breakdown of layer character counts, mostly for observability
   * (we want to know if Joey's edits push the spine over Vertex's
   * cache size limits).
   */
  diagnostics: {
    layer1Chars: number;
    layer2Chars: number;
    layer3Chars: number;
    layer4Chars: number;
    layer5Chars: number;
    layer6Chars: number;
    cacheableChars: number;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Layer 4 — scenario (built from the live document, not the MD tree)
// ─────────────────────────────────────────────────────────────────────

const buildLayer4Scenario = (
  scenario: ScenarioForPrompt | undefined,
): string => {
  if (!scenario) {
    return `# Layer 4 — Scenario

SCENARIO: General English conversation practice. The learner can ask
about anything they need help with.`;
  }
  const vocabList = scenario.vocabulary
    .map((v) => {
      const def = v.definition ? `: ${v.definition}` : "";
      const l1 =
        scenario.l1Code && v.translations?.[scenario.l1Code]
          ? ` (${scenario.l1Code}: ${v.translations[scenario.l1Code]})`
          : "";
      return `- ${v.word}${def}${l1}`;
    })
    .join("\n");
  return `# Layer 4 — Scenario

SCENARIO: ${scenario.title} (id: ${scenario.scenarioId}).
ROLEPLAY SETUP: ${scenario.roleplayPrompt}
GRAMMAR TARGETS: ${scenario.grammarTargets.join(", ")}
CULTURAL NOTES (UK context the learner needs): ${scenario.culturalNotes}
VOCABULARY TO TEACH (weave naturally, do not drill):
${vocabList}
PASS THRESHOLD: turn_score average must reach ${scenario.passThreshold} for session_complete.`;
};

// ─────────────────────────────────────────────────────────────────────
// Layer 5 — dynamic learner profile (rebuilt every call)
// ─────────────────────────────────────────────────────────────────────

const buildLayer5LearnerProfile = (
  learner: LearnerProfileForPrompt,
): string => {
  const vocab = learner.vocabularyToReinforce.length
    ? learner.vocabularyToReinforce.join(", ")
    : "(none yet)";
  const summaries = learner.recentSessionSummaries.length
    ? learner.recentSessionSummaries
        .slice(0, 3)
        .map((s, i) => `${i + 1}. ${s}`)
        .join("\n")
    : "First session.";
  return `# Layer 5 — Learner Profile

LEARNER PROFILE:
- L1 language: ${learner.l1Language || "unknown — default to English"}
- Recent session summaries:
${summaries}
- Skill weakness flags: ${learner.skillWeaknessFlags.join(", ") || "none"}
- Vocabulary to reinforce this session (weave naturally into dialogue): ${vocab}
- Current mode at session start: ${learner.currentMode}
- Advancement ceremony pending: ${
    learner.advancementCeremony
      ? `YES — celebrate the learner's promotion to ${learner.advancementCeremony.toLevel} in their L1 in your first reply, briefly and warmly.`
      : "no"
  }`;
};

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

const SEPARATOR = "\n\n---\n\n";

/**
 * Assemble the six-layer system prompt for one Gemini call.
 *
 * Concatenation order (the wire order Gemini sees):
 *   Layer 1 → 2 → 3 → 4 → 6 → 5
 *
 * The cacheable spine is the first five segments; Layer 5 is appended
 * after the cache reference. Layer 6 lives inside the cache because
 * its content is static; Layer 5 sits at the tail because it's the
 * only thing that changes turn-to-turn.
 */
export const assemblePrompt = (
  learner: LearnerProfileForPrompt,
  scenario?: ScenarioForPrompt,
): AssembledPrompt => {
  const layers = loadLayers();

  const layer3 = layers.layer3.get(learner.esolLevel);
  if (!layer3) {
    throw new ApiError(
      500,
      `No Layer 3 calibration file for level "${learner.esolLevel}" — expected one of e1, e2, e3, l1, l2`,
    );
  }

  const layer4 = buildLayer4Scenario(scenario);
  const layer5 = buildLayer5LearnerProfile(learner);
  const layer6 = layers.layer6;

  const cacheableLayers = [
    layers.layer1,
    layers.layer2,
    layer3,
    layer4,
    layer6,
  ].join(SEPARATOR);

  const systemPrompt = `${cacheableLayers}${SEPARATOR}${layer5}`;

  const cacheKey = createHash("sha256").update(cacheableLayers).digest("hex");

  return {
    systemPrompt,
    cacheableLayers,
    dynamicLayer: layer5,
    cacheKey,
    diagnostics: {
      layer1Chars: layers.layer1.length,
      layer2Chars: layers.layer2.length,
      layer3Chars: layer3.length,
      layer4Chars: layer4.length,
      layer5Chars: layer5.length,
      layer6Chars: layer6.length,
      cacheableChars: cacheableLayers.length,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────
// Vertex caching — wiring point for Function 9
// ─────────────────────────────────────────────────────────────────────

/**
 * STUB — to be wired when Function 9 (live AI tutor turn) lands.
 *
 * Vertex AI's `cachedContents` API lets us upload a static prefix once,
 * receive back a cache resource name, and reference that name on
 * subsequent generateContent calls via the `cachedContent` parameter.
 *
 * The flow in Function 9 will be:
 *   1. Call assemblePrompt(learner, scenario) → { cacheableLayers, cacheKey, dynamicLayer }
 *   2. Look up a `CachedPromptResource` document by cacheKey
 *      - If present + not expired → reuse `cachedContentName`
 *      - If absent → call vertexClient.cachedContents.create({ contents: [...], systemInstruction: cacheableLayers, ttl }) and persist the returned name
 *   3. Call generateContent with:
 *        - cachedContent: cachedContentName
 *        - contents: [dynamicLayer + turn-history + learner input]
 *   4. Vertex bills the cached tokens at a discount (~25% of normal),
 *      and the prefix doesn't have to be re-uploaded every turn.
 *
 * Until that lands, callers fall back to passing `systemPrompt`
 * directly via `systemInstruction` on the GenerativeModel — same
 * pricing as today, no caching benefit, but functionally correct.
 *
 * Documented here rather than in the MD files because this is purely
 * developer-owned wiring.
 */
export const VERTEX_CACHE_TODO = {
  // The TTL Vertex applies to a cache resource. Match this to how
  // often Layer 4 (scenarios) realistically changes. 7 days is the
  // current scenario-update cadence guess; revisit at launch.
  defaultTtlSeconds: 7 * 24 * 60 * 60,
};
