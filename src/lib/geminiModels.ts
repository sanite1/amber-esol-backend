/**
 * Pure model-generation helpers. Deliberately kept OUT of src/lib/gemini.ts:
 * that module owns the Vertex client singleton and is jest.mock()ed by the
 * AI tutor, safeguarding and pronunciation test suites, so any pure helper
 * living there becomes `undefined` under those mocks.
 */

/**
 * True for Gemini 3 and later. The thinking controls are mutually
 * exclusive across generations: 2.5 and earlier take `thinkingBudget`
 * (a token count) and reject `thinkingLevel`; Gemini 3 takes
 * `thinkingLevel` ("low" | "medium" | "high") and rejects
 * `thinkingBudget`. Callers must branch on this rather than assume.
 */
export const isGemini3OrLater = (model: string): boolean => {
  const major = /^gemini-(\d+)/.exec(model)?.[1];
  return major !== undefined && Number(major) >= 3;
};
