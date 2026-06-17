/**
 * Pre-cached safeguarding messages loader — Function 10 To-Do 2.
 *
 * The runtime side of `src/data/safeguarding-messages.json`. Loads the
 * file once at module import (synchronous; the file is tiny — 30 entries
 * total) and serves per-(category, language) lookups with sensible
 * fallbacks.
 *
 * Why a dedicated module:
 *
 *   - The brief mandates that learners in crisis see a message in their
 *     L1, not English. A throw-away inline lookup is fragile — categories
 *     and language codes get mistyped, and the codebase already has a
 *     `child_concern` vs `child_protection` inconsistency (see
 *     SAFEGUARDING_REVIEW.md "Naming reconciliation" section). This
 *     module pins the two boundary mappings in one place so the bug
 *     can't bite again.
 *
 *   - Fall-back chain is deliberate: requested language → English →
 *     hard-coded last-resort. The last-resort is what ships if the JSON
 *     file goes missing in production; it's a single safe English string
 *     so the learner never sees a blank.
 *
 *   - Pure functions + a module-load cache mean the call sites in
 *     aiSession.service.ts (both the keyword path and the AI-only path)
 *     are cheap enough to live in the hot path.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import logger from "../config/logger";
import { SafeguardingCategory } from "../models/SafeguardingKeyword";
import { GeminiSafeguardingCategory } from "../interfaces/geminiTurnOutput.interface";

// ─────────────────────────────────────────────────────────────────────
// File load (module-level cache)
// ─────────────────────────────────────────────────────────────────────

const MESSAGES_PATH = resolve(__dirname, "../data/safeguarding-messages.json");

export type SafeguardingBankCategory =
  | "self_harm"
  | "domestic_abuse"
  | "radicalisation"
  | "child_concern"
  | "exploitation"
  | "mental_health_crisis";

export type SafeguardingBankLanguage =
  | "en"
  | "ar"
  | "yue"
  | "tr"
  // deferred banks (kept; fall back to en when empty)
  | "so"
  | "fa"
  | "zh";

type Bank = Record<
  SafeguardingBankCategory,
  Record<SafeguardingBankLanguage, string>
>;

const LAST_RESORT_EN = `Thank you for sharing that with me. Help is available — please consider:
• NHS 111 (free, 24/7) for urgent medical or mental health support
• Samaritans 116 123 (free, 24/7) — anyone, any concern

If you'd like to keep practising your English, I'm here when you're ready.`;

let bank: Bank | null = null;

const loadBank = (): Bank | null => {
  try {
    const raw = readFileSync(MESSAGES_PATH, "utf8");
    return JSON.parse(raw) as Bank;
  } catch (err) {
    logger.error(
      { err, path: MESSAGES_PATH },
      "Safeguarding messages bank failed to load — falling back to last-resort English string",
    );
    return null;
  }
};

bank = loadBank();

/** Reload — used by tests after editing the file. */
export const __reloadSafeguardingBankForTests = (): void => {
  bank = loadBank();
};

// ─────────────────────────────────────────────────────────────────────
// MongoDB-backed bank (Final Addendum §2 — admin CMS)
// ─────────────────────────────────────────────────────────────────────

/**
 * Rebuild the in-memory bank from the SafeguardingMessage collection.
 *
 * Seeding: on first run (empty collection) the static JSON file is
 * written INTO Mongo so the CMS starts from the authored texts. From
 * then on Mongo is the source of truth and the file is only the
 * fail-safe (Mongo unreachable → keep whatever bank we already have,
 * which at minimum is the module-load file copy).
 *
 * Called at server boot (src/index.ts) and after every admin edit —
 * "reloads without deployment" per the brief.
 */
export const reloadSafeguardingBankFromDb = async (): Promise<void> => {
  // Lazy import dodges a circular dependency risk at module load.
  const { default: SafeguardingMessage } = await import(
    "../models/SafeguardingMessage"
  );

  try {
    let rows = await SafeguardingMessage.find({}).lean();

    // Additive reconcile: insert any (category, language) pair present
    // in the JSON file but missing from Mongo. Never overwrites an
    // existing row, so admin CMS edits are preserved AND newly-added
    // languages (e.g. tr/yue) propagate into an already-seeded DB on
    // next boot without a manual migration.
    const fileBank = loadBank();
    if (fileBank) {
      const existing = new Set(rows.map((r) => `${r.category}|${r.language}`));
      const toInsert: Array<{
        category: string;
        language: string;
        text: string;
      }> = [];
      for (const [category, langs] of Object.entries(fileBank)) {
        for (const [language, text] of Object.entries(langs)) {
          if (!existing.has(`${category}|${language}`)) {
            toInsert.push({ category, language, text: text ?? "" });
          }
        }
      }
      if (toInsert.length > 0) {
        await SafeguardingMessage.insertMany(toInsert, {
          ordered: false,
        }).catch(() => undefined); // unique-index races on parallel boots are fine
        rows = await SafeguardingMessage.find({}).lean();
        logger.info(
          { seeded: toInsert.length },
          "Safeguarding messages: inserted missing (category,language) pairs from JSON",
        );
      }
    }

    if (rows.length > 0) {
      const next = {} as Bank;
      for (const r of rows) {
        const cat = r.category as SafeguardingBankCategory;
        const lang = r.language as SafeguardingBankLanguage;
        if (!next[cat])
          next[cat] = {} as Record<SafeguardingBankLanguage, string>;
        next[cat][lang] = r.text ?? "";
      }
      bank = next;
      logger.info(
        { entries: rows.length },
        "Safeguarding message bank loaded from Mongo",
      );
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "Safeguarding bank DB load failed — keeping current in-memory bank",
    );
  }
};

/** Read-only snapshot for the admin CMS editor. */
export const getSafeguardingBankSnapshot = (): Bank | null => bank;

// ─────────────────────────────────────────────────────────────────────
// L1 language → bank language code mapping
// ─────────────────────────────────────────────────────────────────────

/**
 * Map the learner's free-text L1 (User.l1Language) onto a bank code.
 *
 * MVP banks: en, ar, yue (Cantonese — its own bank now), tr (Turkish).
 * Deferred banks kept for existing learners: so, fa, zh. Pashto degrades
 * to Farsi script (`fa`); generic/Mandarin Chinese stays `zh`. English
 * is the universal fall-back when L1 is missing or unrecognised.
 *
 * Case-insensitive, whitespace-tolerant.
 */
export const mapL1ToLanguageCode = (
  l1Language: string | null | undefined,
): SafeguardingBankLanguage => {
  if (!l1Language) return "en";
  const norm = String(l1Language).trim().toLowerCase();

  switch (norm) {
    case "en":
    case "english":
      return "en";
    case "ar":
    case "arabic":
      return "ar";
    case "yue":
    case "yue-hk":
    case "cantonese":
      return "yue";
    case "tr":
    case "turkish":
      return "tr";
    case "so":
    case "somali":
      return "so";
    case "fa":
    case "fa-af":
    case "dari":
    case "farsi":
    case "persian":
    case "ps":
    case "pashto":
      // Pashto degrades to Farsi script — see brief Function 10 To-Do 1
      // and SAFEGUARDING_REVIEW.md
      return "fa";
    case "zh":
    case "zh-hk":
    case "chinese":
    case "mandarin":
      return "zh";
    default:
      return "en";
  }
};

// ─────────────────────────────────────────────────────────────────────
// Category mapping (Gemini's enum ⇆ bank keys)
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalise a category from either source (the SafeguardingDetector
 * which uses `child_concern`, or Gemini which uses `child_protection`)
 * onto the bank's key set.
 *
 * Tracked as engineering follow-up in SAFEGUARDING_REVIEW.md — once the
 * one-PR rename to `child_concern` lands across the validator + audit
 * + keyword seed, this function collapses to a noop. Until then it
 * lives here as the single bridging point.
 */
export const mapCategoryToBankKey = (
  category:
    | SafeguardingCategory
    | GeminiSafeguardingCategory
    | string
    | null
    | undefined,
): SafeguardingBankCategory | null => {
  if (!category) return null;
  const c = String(category).toLowerCase();
  switch (c) {
    case "self_harm":
    case "domestic_abuse":
    case "radicalisation":
    case "exploitation":
    case "mental_health_crisis":
    case "child_concern":
      return c as SafeguardingBankCategory;
    case "child_protection":
      // Gemini enum → bank enum bridge
      return "child_concern";
    default:
      return null;
  }
};

// ─────────────────────────────────────────────────────────────────────
// The lookup
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the safest pre-cache reply for (category, L1).
 *
 * Fall-back chain:
 *   1. bank[category][langCode]            — first choice
 *   2. bank[category]["en"]                — language miss / empty string
 *      (e.g. translations not yet signed off — Step 5 of the review)
 *   3. bank["mental_health_crisis"]["en"]  — category miss (best
 *      generic crisis message)
 *   4. LAST_RESORT_EN constant             — bank file missing entirely
 *
 * Never throws. The whole point of a pre-cache is that it cannot fail
 * a learner in crisis.
 */
export const loadSafeguardingMessage = (
  category:
    | SafeguardingCategory
    | GeminiSafeguardingCategory
    | string
    | null
    | undefined,
  l1Language: string | null | undefined,
): string => {
  if (!bank) return LAST_RESORT_EN;

  const langCode = mapL1ToLanguageCode(l1Language);
  const bankCategory = mapCategoryToBankKey(category);

  // Try the category × language slot
  if (bankCategory) {
    const slot = bank[bankCategory]?.[langCode];
    if (typeof slot === "string" && slot.trim().length > 0) return slot;

    // Fall back to English within the same category
    const enSlot = bank[bankCategory]?.en;
    if (typeof enSlot === "string" && enSlot.trim().length > 0) {
      if (langCode !== "en") {
        logger.warn(
          { category: bankCategory, langCode },
          "Safeguarding message not yet translated — serving English fallback (per SAFEGUARDING_REVIEW.md Step 5)",
        );
      }
      return enSlot;
    }
  }

  // Category miss — use the generic crisis message in English
  const generic = bank.mental_health_crisis?.en;
  if (typeof generic === "string" && generic.trim().length > 0) {
    logger.warn(
      { category, langCode },
      "Safeguarding category unrecognised — serving generic mental_health_crisis English message",
    );
    return generic;
  }

  return LAST_RESORT_EN;
};

export const SAFEGUARDING_LAST_RESORT_EN = LAST_RESORT_EN;
