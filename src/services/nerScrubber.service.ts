/**
 * PII scrubber — strips identifying information from learner input
 * before it leaves our infrastructure for any third-party AI.
 *
 * Patterns are tuned for UK context (postcodes, NHS numbers, NI numbers).
 * Conservative-by-design: false positives are preferable to PII leakage.
 */

export interface ScrubResult {
  scrubbed: string;
  redactionsApplied: string[];
  scrubbedCount: number;
}

const PATTERNS: { label: string; regex: RegExp }[] = [
  // Email addresses
  {
    label: "EMAIL",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  // UK phone numbers — +44, 0044, or leading 0, 9-11 digits
  {
    label: "PHONE",
    regex:
      /(?:(?:\+44|0044)\s?(?:\(0\))?\s?|0)(?:\d\s?){9,10}/g,
  },
  // UK postcode (Royal Mail format)
  {
    label: "POSTCODE",
    regex:
      /\b[A-PR-UWYZ](?:[A-HK-Y][0-9](?:[0-9]|[ABEHMNPRV-Y])?|[0-9](?:[0-9]|[A-HJKPS-UW])?)\s?[0-9][ABD-HJLNP-UW-Z]{2}\b/gi,
  },
  // NHS number (10 digits, optional spaces or dashes in 3-3-4 grouping)
  {
    label: "NHS_NUMBER",
    regex: /\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/g,
  },
  // National Insurance number (e.g. AB123456C)
  {
    label: "NI_NUMBER",
    regex:
      /\b[A-CEGHJ-PR-TW-Z]{1}[A-CEGHJ-NPR-TW-Z]{1}\d{6}[A-D]?\b/gi,
  },
  // UK bank sort code (xx-xx-xx)
  {
    label: "SORT_CODE",
    regex: /\b\d{2}-\d{2}-\d{2}\b/g,
  },
  // Long digit runs that look like account or card numbers (8+ digits)
  {
    label: "ACCOUNT_NUMBER",
    regex: /\b\d{8,}\b/g,
  },
];

export const scrubPII = (input: string): ScrubResult => {
  let scrubbed = input;
  const redactionsApplied: string[] = [];
  let scrubbedCount = 0;

  for (const { label, regex } of PATTERNS) {
    scrubbed = scrubbed.replace(regex, () => {
      redactionsApplied.push(label);
      scrubbedCount++;
      return `[${label}]`;
    });
  }

  return {
    scrubbed,
    redactionsApplied,
    scrubbedCount,
  };
};
