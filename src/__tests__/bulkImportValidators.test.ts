/**
 * Per-validator unit tests for the bulk-learner-import service.
 *
 * These functions are the actual compliance gates — one regression
 * ships bad data. They're pure (no DB, no I/O) so testing them with
 * a table-driven case set is the cheapest possible coverage.
 *
 * Suite is intentionally NOT loaded through the streaming pipeline;
 * we want each function tested in isolation so a failure points
 * directly at the broken predicate.
 */

import {
  validateRequired,
  validateIsoDate,
  validateEnum,
  validateUkPostcode,
  validateUln,
  validateLlddHealthProb,
  validateEmail,
  validateAgeAtEnrolment,
} from "../services/orgAdminImport.service";

const ROW = 42; // sentinel row number that appears in every error path

describe("validateRequired", () => {
  it("accepts a non-empty trimmed string", () => {
    expect(validateRequired("Aamina", "firstname", ROW)).toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    const err = validateRequired(value, "firstname", ROW);
    expect(err).not.toBeNull();
    expect(err).toMatchObject({
      row: ROW,
      field: "firstname",
      message: "firstname is required",
    });
  });
});

describe("validateIsoDate", () => {
  it("accepts a well-formed ISO date", () => {
    expect(validateIsoDate("1995-04-12", "date_of_birth", ROW)).toBeNull();
  });

  it("rejects DD/MM/YYYY format", () => {
    const err = validateIsoDate("12/04/1995", "date_of_birth", ROW);
    expect(err).toMatchObject({
      row: ROW,
      field: "date_of_birth",
      message: "date_of_birth must be in YYYY-MM-DD format",
    });
  });

  it("rejects an impossible calendar date even when format-valid", () => {
    // 2025-13-40 matches the regex but isn't a real date.
    const err = validateIsoDate("2025-13-40", "date_of_birth", ROW);
    expect(err).not.toBeNull();
    // The regex check fires first ("Invalid date format") OR the date
    // parser fires on month > 12 — either output is acceptable.
    expect(err!.field).toBe("date_of_birth");
  });

  it("rejects a non-string input", () => {
    const err = validateIsoDate(19950412 as any, "date_of_birth", ROW);
    expect(err).not.toBeNull();
  });
});

describe("validateEnum", () => {
  const ALLOWED = ["e1", "e2", "e3", "l1", "l2"] as const;

  it("accepts a valid enum value", () => {
    expect(validateEnum("e2", "level", ALLOWED, ROW)).toBeNull();
  });

  it("accepts an uppercased value (the validator lowercases)", () => {
    expect(validateEnum("E2", "level", ALLOWED, ROW)).toBeNull();
  });

  it("rejects an out-of-set value", () => {
    const err = validateEnum("intermediate", "level", ALLOWED, ROW);
    expect(err).toMatchObject({
      row: ROW,
      field: "level",
      message: "level must be one of: e1, e2, e3, l1, l2",
    });
  });

  it("rejects a non-string input", () => {
    const err = validateEnum(2 as any, "level", ALLOWED, ROW);
    expect(err).not.toBeNull();
  });
});

describe("validateUkPostcode", () => {
  it.each(["M1 1AE", "SW1A 1AA", "B15 2TT", "EC1A 1BB", "LS1 4DT"])(
    "accepts %s",
    (postcode) => {
      expect(validateUkPostcode(postcode, ROW)).toBeNull();
    },
  );

  it.each([
    ["empty", ""],
    ["wrong format", "ABCD"],
    ["too short", "M1"],
    ["digits only", "12345"],
  ])("rejects %s", (_label, value) => {
    const err = validateUkPostcode(value, ROW);
    expect(err).toMatchObject({ row: ROW, field: "postcode_prior" });
  });

  it("accepts the Royal Mail sentinel ZZ99 9ZZ at format level", () => {
    // Format-only — the runtime PostcodeRouter.lookup will return null,
    // which is the soft-warning path. This validator only checks shape.
    expect(validateUkPostcode("ZZ99 9ZZ", ROW)).toBeNull();
  });
});

describe("validateUln", () => {
  it("accepts a blank value (uln is optional)", () => {
    expect(validateUln("", ROW)).toBeNull();
    expect(validateUln(null, ROW)).toBeNull();
    expect(validateUln(undefined, ROW)).toBeNull();
  });

  it("accepts a 10-digit ULN", () => {
    expect(validateUln("1234567890", ROW)).toBeNull();
  });

  it.each([
    ["9 digits", "123456789"],
    ["11 digits", "12345678901"],
    ["letters mixed in", "12345ABCDE"],
    ["spaces", "123 456 789"],
  ])("rejects %s", (_label, value) => {
    const err = validateUln(value, ROW);
    expect(err).toMatchObject({ row: ROW, field: "uln" });
  });
});

describe("validateLlddHealthProb", () => {
  it.each([1, 2, 9])("accepts the canonical value %s", (n) => {
    expect(validateLlddHealthProb(n, ROW)).toBeNull();
  });

  it.each(["1", "2", "9"])("accepts the string form %s", (s) => {
    expect(validateLlddHealthProb(s, ROW)).toBeNull();
  });

  it("rejects blank — must be sourced from the learner, never defaulted", () => {
    const err = validateLlddHealthProb("", ROW);
    expect(err).toMatchObject({
      row: ROW,
      field: "lldd_health_prob",
      message:
        "lldd_health_prob is required — must be sourced from the learner, never defaulted",
    });
  });

  it.each([
    ["0", 0],
    ["3", 3],
    ['"no"', "no"],
    ['"yes"', "yes"],
    ["true", true],
  ])("rejects %s — only 1/2/9 are valid", (_label, value) => {
    const err = validateLlddHealthProb(value as any, ROW);
    expect(err).not.toBeNull();
    expect(err!.field).toBe("lldd_health_prob");
  });
});

describe("validateEmail", () => {
  it("accepts a well-formed email", () => {
    expect(validateEmail("aamina@example.org", ROW)).toBeNull();
  });

  it("accepts a blank value (email is optional)", () => {
    expect(validateEmail("", ROW)).toBeNull();
    expect(validateEmail(null, ROW)).toBeNull();
    expect(validateEmail(undefined, ROW)).toBeNull();
  });

  it("rejects a string without @", () => {
    const err = validateEmail("not-an-email", ROW);
    expect(err).toMatchObject({ row: ROW, field: "email" });
  });

  it("rejects a string without a domain TLD", () => {
    const err = validateEmail("aamina@example", ROW);
    expect(err).toMatchObject({ row: ROW, field: "email" });
  });
});

describe("validateAgeAtEnrolment", () => {
  it("accepts a learner who is ≥ 16 on enrolment_date", () => {
    expect(validateAgeAtEnrolment("2000-01-01", "2026-01-15", ROW)).toBeNull();
  });

  it("accepts a learner who turns 16 exactly on enrolment_date", () => {
    expect(validateAgeAtEnrolment("2010-01-15", "2026-01-15", ROW)).toBeNull();
  });

  it("rejects a learner who is 15 on enrolment_date", () => {
    const err = validateAgeAtEnrolment("2010-01-16", "2026-01-15", ROW);
    expect(err).toMatchObject({
      row: ROW,
      field: "date_of_birth",
      message: "learner must be at least 16 years old on enrolment_date",
    });
  });

  it("returns null silently when either date is missing — per-field validators already errored", () => {
    expect(validateAgeAtEnrolment(undefined, "2026-01-15", ROW)).toBeNull();
    expect(validateAgeAtEnrolment("2000-01-01", undefined, ROW)).toBeNull();
  });

  it("returns null silently when either date is malformed", () => {
    expect(validateAgeAtEnrolment("not-a-date", "2026-01-15", ROW)).toBeNull();
  });
});
