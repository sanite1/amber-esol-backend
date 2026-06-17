/**
 * Canonical Project Silk language registry — the single source of
 * truth for which languages are live (MVP) vs shelved (deferred).
 *
 * The AI Tutor Brief §3 locks the MVP to Arabic · Cantonese · Turkish
 * · English (Turkish because the launch territory is Enfield/Haringey;
 * Cantonese for the BN(O) route). Somali, Dari, Pashto, Bengali, Urdu
 * and generic Chinese are **deferred, not deleted** — kept here behind
 * the deferred set so the revenue-/coverage-triggered revival (premium
 * neural TTS, Sylheti dialect test, first paying contracts) is a config
 * flip, not a re-build.
 *
 * Codes are the canonical internal codes used across the copy bank,
 * scenario translations, safeguarding patterns/messages and (Phase 7)
 * the Google TTS/STT voice map. Cantonese is `yue` (yue-HK), never the
 * generic `zh`.
 */

export type SilkLanguage =
  // MVP — live
  | "en"
  | "ar"
  | "yue"
  | "tr"
  // Deferred — shelved behind the deferred set
  | "zh"
  | "so"
  | "fa"
  | "ps"
  | "bn"
  | "ur";

export const MVP_LANGUAGES: readonly SilkLanguage[] = [
  "en",
  "ar",
  "yue",
  "tr",
] as const;

export const DEFERRED_LANGUAGES: readonly SilkLanguage[] = [
  "zh",
  "so",
  "fa",
  "ps",
  "bn",
  "ur",
] as const;

export interface LanguageMeta {
  code: SilkLanguage;
  /** Endonym shown in pickers. */
  label: string;
  dir: "ltr" | "rtl";
  /** Google Cloud TTS/STT locale (Phase 7 voice). null when deferred
   *  pending premium neural coverage. */
  voiceLocale: string | null;
}

export const LANGUAGE_META: Record<SilkLanguage, LanguageMeta> = {
  en: { code: "en", label: "English", dir: "ltr", voiceLocale: "en-GB" },
  ar: { code: "ar", label: "العربية", dir: "rtl", voiceLocale: "ar-XA" },
  yue: { code: "yue", label: "粵語", dir: "ltr", voiceLocale: "yue-HK" },
  tr: { code: "tr", label: "Türkçe", dir: "ltr", voiceLocale: "tr-TR" },
  // Deferred — no premium neural TTS confirmed (June 2026) or revenue-
  // triggered; voiceLocale null until coverage/contract lands.
  zh: { code: "zh", label: "中文", dir: "ltr", voiceLocale: null },
  so: { code: "so", label: "Soomaali", dir: "ltr", voiceLocale: null },
  fa: { code: "fa", label: "دری", dir: "rtl", voiceLocale: null },
  ps: { code: "ps", label: "پښتو", dir: "rtl", voiceLocale: null },
  bn: { code: "bn", label: "বাংলা", dir: "ltr", voiceLocale: null },
  ur: { code: "ur", label: "اردو", dir: "rtl", voiceLocale: null },
};

export const isMvpLanguage = (code: string): code is SilkLanguage =>
  (MVP_LANGUAGES as readonly string[]).includes(code);

/**
 * Map a free-text / legacy L1 value (User.l1Language can be "Arabic",
 * "ar", "cantonese", "fa-AF", …) onto a canonical code. Deferred
 * languages still resolve (so existing learners keep working); callers
 * gate on isMvpLanguage where MVP-only behaviour is required. Returns
 * "en" when unrecognised — English is the universal fallback.
 */
export const toSilkLanguage = (raw: unknown): SilkLanguage => {
  if (typeof raw !== "string" || !raw.trim()) return "en";
  const k = raw.trim().toLowerCase();
  const map: Record<string, SilkLanguage> = {
    en: "en",
    english: "en",
    ar: "ar",
    arabic: "ar",
    yue: "yue",
    "yue-hk": "yue",
    cantonese: "yue",
    tr: "tr",
    turkish: "tr",
    zh: "zh",
    "zh-hk": "zh",
    chinese: "zh",
    mandarin: "zh",
    so: "so",
    somali: "so",
    fa: "fa",
    "fa-af": "fa",
    dari: "fa",
    farsi: "fa",
    persian: "fa",
    ps: "ps",
    pashto: "ps",
    bn: "bn",
    bengali: "bn",
    ur: "ur",
    urdu: "ur",
  };
  return map[k] ?? "en";
};
