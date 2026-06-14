/**
 * Deterministic CSV generator for the Function 3 D2 acceptance suite.
 *
 * Produces:
 *   - A 50-row "original" CSV with 5 problem rows at known positions
 *   - A 5-row "corrected" CSV that targets the same emails as the
 *     original problem rows, so the idempotency key matches for the
 *     soft-warning row and the four hard-failure rows import fresh.
 *
 * Determinism matters: the test asserts exact row numbers, exact field
 * names, and exact error messages. Anything pseudo-random would make
 * the test flaky against the row-number assertions.
 *
 * Can also be run standalone to drop the original file at
 * /tmp/test-bulk-import.csv for manual inspection:
 *     npx ts-node src/__tests__/fixtures/bulkImportFixture.ts
 */

import { writeFileSync } from "fs";

// ── Column order ─────────────────────────────────────────────────────
const HEADERS = [
  "firstname",
  "lastname",
  "date_of_birth",
  "nationality",
  "l1_language",
  "postcode_prior",
  "uln",
  "esol_level_at_import",
  "enrolment_date",
  "employment_status",
  "lldd_health_prob",
  "aim_type",
  "email",
] as const;

type RowKey = (typeof HEADERS)[number];
type Row = Record<RowKey, string>;

// ── Reference data ───────────────────────────────────────────────────

// 50 British name pairs — keeps the CSV reading like a real cohort.
const NAMES: [string, string][] = [
  ["Oliver", "Smith"],
  ["Amelia", "Jones"],
  ["George", "Williams"],
  ["Isla", "Taylor"],
  ["Noah", "Davies"],
  ["Mia", "Brown"],
  ["Leo", "Wilson"],
  ["Ava", "Thomas"],
  ["Arthur", "Roberts"],
  ["Lily", "Johnson"],
  ["Charlie", "Lewis"],
  ["Sophia", "Wright"],
  ["Henry", "Robinson"],
  ["Grace", "Walker"],
  ["Jack", "Hall"],
  ["Freya", "Young"],
  ["Theo", "King"],
  ["Daisy", "Allen"],
  ["Oscar", "Scott"],
  ["Evie", "Green"],
  ["Lucas", "Adams"],
  ["Poppy", "Baker"],
  ["Harry", "Carter"],
  ["Ruby", "Mitchell"],
  ["Edward", "Bell"],
  ["Florence", "Cooper"],
  ["Alfie", "Reed"],
  ["Ivy", "Stewart"],
  ["Joshua", "Murphy"],
  ["Alice", "Howard"],
  ["Sebastian", "Ward"],
  ["Phoebe", "Cox"],
  ["Ethan", "Bennett"],
  ["Eliza", "Russell"],
  ["Albert", "Watson"],
  ["Matilda", "Sanders"],
  ["Reuben", "Foster"],
  ["Sienna", "Hughes"],
  ["Roman", "Powell"],
  ["Esme", "Butler"],
  ["Casper", "Reid"],
  ["Aria", "Hayes"],
  ["Jude", "Gibson"],
  ["Eleanor", "Knight"],
  ["Caleb", "Webb"],
  ["Iris", "Hunter"],
  ["Aaron", "Murray"],
  ["Hazel", "Black"],
  ["Levi", "Hudson"],
  ["Margot", "Owen"],
];

// 30 real UK postcodes across major MCAs — cycle to fill 50 rows.
const POSTCODES = [
  "SW1A 1AA",
  "E1 6AN",
  "NW1 2DB",
  "SE1 7PB",
  "W1A 1AA",
  "EC1A 1BB",
  "WC1E 6BT",
  "N1 9GU",
  "E14 5AB",
  "SW7 2AZ",
  "B1 1AA",
  "B2 4QA",
  "B15 2TT",
  "B4 7DA",
  "S1 2HE",
  "S10 2JA",
  "S3 8RD",
  "S11 8NA",
  "M1 1AE",
  "M14 5BD",
  "M3 4JE",
  "LS1 4DT",
  "LS2 9JT",
  "LS6 4QB",
  "BS1 4DJ",
  "BS8 1TH",
  "NE1 4ST",
  "NE2 4HH",
  "L1 8JQ",
  "L3 5UX",
];

const L1S = [
  "arabic",
  "somali",
  "dari",
  "pashto",
  "cantonese",
  "english",
  "other",
];
const LEVELS = ["e1", "e2", "e3", "l1", "l2"];
const EMPS = [
  "unemployed",
  "employed",
  "self_employed",
  "not_in_labour_market",
];
const LLDD = [1, 2, 9];
const AIMS = ["regulated", "non_regulated"];
const NATIONALITIES = [
  "Somali",
  "Afghan",
  "Syrian",
  "Eritrean",
  "Sudanese",
  "Iranian",
  "Iraqi",
  "Hong Konger",
  "Ukrainian",
  "Albanian",
];

// ── Problem row positions (1-indexed data rows) ──────────────────────

export const PROBLEM_ROWS = {
  MISSING_LLDD: 7,
  BAD_DATE: 17,
  INVALID_LEVEL: 27,
  POSTCODE_NOT_IN_DATASET: 37,
  INVALID_AIM_TYPE: 47,
} as const;

// "ZZ99 9ZZ" passes the UK postcode regex (Z, Z, 9, 9, space, 9, Z, Z)
// but is the Royal Mail reserved "no real address" code — guaranteed
// not to be in any DfE ASF dataset. The PostcodeRouter mock returns
// null for this value; production Redis would too.
export const POSTCODE_NOT_IN_DATASET = "ZZ99 9ZZ";

// ── Helpers ──────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Deterministic date of birth between 1970-01-01 and 2004-12-28.
 * Always ≥ 16 years old on the 2026-01-15 enrolment date used below.
 */
const dobForRow = (idx: number): string => {
  const year = 1970 + (idx % 35); // 1970–2004
  const month = ((idx * 5) % 12) + 1; // 1–12
  const day = ((idx * 11) % 28) + 1; // 1–28 (safe across months)
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

/** 10-digit ULN; even-numbered rows leave it blank. */
const ulnForRow = (idx: number): string =>
  idx % 2 === 0 ? "" : String(1000000000 + idx * 7919).slice(0, 10);

const emailForRow = (idx: number): string => `learner-${idx}@test-import.local`;

/**
 * Build the canonical (valid) version of row `idx`. Problem rows are
 * derived from this and mutated below.
 */
const validRow = (idx: number): Row => {
  const [first, last] = NAMES[idx - 1];
  return {
    firstname: first,
    lastname: last,
    date_of_birth: dobForRow(idx),
    nationality: NATIONALITIES[idx % NATIONALITIES.length],
    l1_language: L1S[idx % L1S.length],
    postcode_prior: POSTCODES[idx % POSTCODES.length],
    uln: ulnForRow(idx),
    esol_level_at_import: LEVELS[idx % LEVELS.length],
    enrolment_date: "2026-01-15",
    employment_status: EMPS[idx % EMPS.length],
    lldd_health_prob: String(LLDD[idx % LLDD.length]),
    aim_type: AIMS[idx % AIMS.length],
    email: emailForRow(idx),
  };
};

const escapeCsv = (v: string): string => {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
};

const rowsToCsv = (rows: Row[]): string => {
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push(HEADERS.map((h) => escapeCsv(r[h] ?? "")).join(","));
  }
  return lines.join("\n") + "\n";
};

// ── Generators ───────────────────────────────────────────────────────

/**
 * 50 rows total. Rows 1–50 are valid by default; positions in
 * PROBLEM_ROWS are then mutated with deliberate faults.
 */
export function generateOriginalCsv(): string {
  const rows: Row[] = Array.from({ length: 50 }, (_, i) => validRow(i + 1));

  // Row 7 — missing lldd_health_prob.
  rows[PROBLEM_ROWS.MISSING_LLDD - 1].lldd_health_prob = "";

  // Row 17 — DD/MM/YYYY date format instead of YYYY-MM-DD.
  rows[PROBLEM_ROWS.BAD_DATE - 1].date_of_birth = "12/04/1995";

  // Row 27 — non-enum esol_level_at_import.
  rows[PROBLEM_ROWS.INVALID_LEVEL - 1].esol_level_at_import = "intermediate";

  // Row 37 — postcode parses as UK but not in dataset (soft warning).
  rows[PROBLEM_ROWS.POSTCODE_NOT_IN_DATASET - 1].postcode_prior =
    POSTCODE_NOT_IN_DATASET;

  // Row 47 — non-enum aim_type.
  rows[PROBLEM_ROWS.INVALID_AIM_TYPE - 1].aim_type = "mixed";

  return rowsToCsv(rows);
}

/**
 * 5-row corrected file. Same emails + DOBs as the original problem
 * rows so the idempotency key collides for the soft-warning case (the
 * ZZ99 row already imported as manual_review). The four hard-failure
 * rows have no prior idempotency row, so they import fresh.
 *
 * Returned rows are 1-indexed in this file (row 1 = the corrected
 * lldd row, etc). The original file's row number is preserved only
 * in the User document via email.
 */
export function generateCorrectedCsv(): string {
  const idxs = [
    PROBLEM_ROWS.MISSING_LLDD,
    PROBLEM_ROWS.BAD_DATE,
    PROBLEM_ROWS.INVALID_LEVEL,
    PROBLEM_ROWS.POSTCODE_NOT_IN_DATASET,
    PROBLEM_ROWS.INVALID_AIM_TYPE,
  ];
  const rows = idxs.map((origIdx) => {
    const fixed = validRow(origIdx);
    // The corrected ZZ99 row swaps the postcode for a real one, but its
    // email + DOB match the original ZZ99 row → idempotency hit, no
    // database mutation. That's the documented invariant.
    return fixed;
  });
  return rowsToCsv(rows);
}

// ── Standalone entry: write the CSV to /tmp for manual inspection ───

if (require.main === module) {
  const original = generateOriginalCsv();
  writeFileSync("/tmp/test-bulk-import.csv", original);
  const corrected = generateCorrectedCsv();
  writeFileSync("/tmp/test-bulk-import-corrected.csv", corrected);
  // eslint-disable-next-line no-console
  console.log(
    `Wrote /tmp/test-bulk-import.csv (${original.length} bytes, 50 rows) ` +
      `and /tmp/test-bulk-import-corrected.csv (${corrected.length} bytes, 5 rows)`,
  );
}
