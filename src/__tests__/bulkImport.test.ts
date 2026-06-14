/**
 * Function 3 D2 acceptance suite — brief Function 3 To-Do 4.
 *
 * Drives importLearnersService through three end-to-end scenarios:
 *
 *   D2-1  Original 50-row CSV with 4 hard-failure rows + 1 soft-warning
 *         row → summary reports 46 imported, 4 failed, 1 warning, and
 *         every learner doc has the right org_id / sof_code / ILR fields.
 *
 *   D2-2  Re-uploading a corrected 5-row CSV imports the 4 hard-failure
 *         rows fresh and leaves the previously-imported ZZ99 row as a
 *         duplicate (idempotency cache hit). Final user count = 50, NOT
 *         95 — the original 45 valid rows are not re-imported because
 *         they aren't in the corrected file at all.
 */

// ── Module mocks (must precede imports of code under test) ──────────

jest.mock("../services/postcodeRouter.service", () => ({
  __esModule: true,
  default: { lookup: jest.fn() },
}));

jest.mock("../services/notification.service", () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/ComplianceConfigService", () => ({
  __esModule: true,
  default: { getCurrent: jest.fn().mockReturnValue({ version: 1 }) },
}));

import { writeFileSync } from "fs";
import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import IdempotencyKey from "../models/IdempotencyKey";
import { importLearnersService } from "../services/orgAdminImport.service";
import PostcodeRouter from "../services/postcodeRouter.service";
import { createNotification } from "../services/notification.service";
import {
  generateOriginalCsv,
  generateCorrectedCsv,
  PROBLEM_ROWS,
  POSTCODE_NOT_IN_DATASET,
} from "./fixtures/bulkImportFixture";

const mockedLookup = (PostcodeRouter as unknown as { lookup: jest.Mock })
  .lookup;
const mockedNotify = createNotification as jest.Mock;

// ── Helpers ──────────────────────────────────────────────────────────

const normalisePostcode = (pc: string) => pc.toUpperCase().replace(/\s+/g, "");

/**
 * Default postcode mock: every postcode resolves to a fixed SOF EXCEPT
 * the ZZ999ZZ Royal Mail sentinel, which resolves to null. Lets the
 * test exercise the warning path without spinning up Redis.
 */
const installPostcodeMock = () => {
  mockedLookup.mockImplementation(async (postcode: string) => {
    if (normalisePostcode(postcode) === "ZZ999ZZ") return null;
    return {
      sof: "108",
      ldm: "001",
      mca: "GLA",
      authority_name: "Greater London Authority",
    };
  });
};

const createOrg = async () =>
  Organisation.create({
    name: "D2 Test College",
    slug: `d2-org-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@d2.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createActor = async (orgId: Types.ObjectId) =>
  User.create({
    firstname: "D2",
    lastname: "Actor",
    email: `actor-${Date.now()}@d2.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "org_admin",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
  });

const csvToFile = (csv: string): Express.Multer.File =>
  ({ buffer: Buffer.from(csv, "utf8") }) as Express.Multer.File;

// ── Cross-test scaffolding ───────────────────────────────────────────

beforeAll(() => {
  // Drop the fixture on disk so a developer can inspect the exact bytes
  // that drove the test run.
  writeFileSync("/tmp/test-bulk-import.csv", generateOriginalCsv());
  writeFileSync("/tmp/test-bulk-import-corrected.csv", generateCorrectedCsv());
});

beforeEach(() => {
  jest.clearAllMocks();
  installPostcodeMock();
});

// ─────────────────────────────────────────────────────────────────────
// D2-1 — original mixed CSV
// ─────────────────────────────────────────────────────────────────────

describe("D2-1 — original mixed CSV", () => {
  it("imports 46 of 50 rows, surfaces 4 errors and 1 warning with exact row numbers", async () => {
    const org = await createOrg();
    const actor = await createActor(org._id);

    const csv = generateOriginalCsv();
    const res = await importLearnersService(
      csvToFile(csv),
      org._id.toString(),
      actor._id.toString(),
    );

    expect(res.statusCode).toBe(200);
    const summary = res.data as {
      total: number;
      imported: number;
      failed: number;
      duplicate: number;
      errors: { row: number; field: string; message: string }[];
      warnings: { row: number; field: string; message: string }[];
    };

    // ── Top-line counters ────────────────────────────────────────
    // 45 clean + 1 ZZ99 (imports as manual_review with a warning) = 46.
    // 4 hard-failure rows = 4. No re-uploads yet → duplicate = 0.
    expect(summary.total).toBe(50);
    expect(summary.imported).toBe(46);
    expect(summary.failed).toBe(4);
    expect(summary.duplicate).toBe(0);
    expect(summary.imported + summary.failed + summary.duplicate).toBe(
      summary.total,
    );

    // ── Errors: exact row, field, and message text ───────────────
    const errByRow = new Map<number, { field: string; message: string }>();
    for (const e of summary.errors) errByRow.set(e.row, e);

    expect(errByRow.get(PROBLEM_ROWS.MISSING_LLDD)).toMatchObject({
      field: "lldd_health_prob",
      message:
        "lldd_health_prob is required — must be sourced from the learner, never defaulted",
    });
    expect(errByRow.get(PROBLEM_ROWS.BAD_DATE)).toMatchObject({
      field: "date_of_birth",
      message: "date_of_birth must be in YYYY-MM-DD format",
    });
    expect(errByRow.get(PROBLEM_ROWS.INVALID_LEVEL)).toMatchObject({
      field: "esol_level_at_import",
      message: "esol_level_at_import must be one of: e1, e2, e3, l1, l2",
    });
    expect(errByRow.get(PROBLEM_ROWS.INVALID_AIM_TYPE)).toMatchObject({
      field: "aim_type",
      message: "aim_type must be one of: regulated, non_regulated",
    });

    // ── Warnings: the ZZ99 row imported but flagged ──────────────
    // Per the To-Do 3 design: format-valid but undatasetted postcodes
    // are SOFT issues. Row still commits with sof_code=null and
    // funding_status="manual_review"; admin gets a single batched
    // notification at the end of the run.
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatchObject({
      row: PROBLEM_ROWS.POSTCODE_NOT_IN_DATASET,
      field: "postcode_prior",
      message: "postcode not found — manual SOF review required",
    });

    // ── Database: 46 learners exist, attached to the correct org ─
    const learners = await User.find({
      orgId: org._id,
      role: "student",
    }).lean();
    expect(learners).toHaveLength(46);
    for (const l of learners) {
      expect(String(l.orgId)).toBe(org._id.toString());
    }

    // ── Spot-check a normal row (row 1, Oliver Smith, SW1A 1AA) ──
    const oliver = learners.find((l) => l.firstname === "Oliver");
    expect(oliver).toBeTruthy();
    expect(oliver!.lastname).toBe("Smith");
    expect((oliver as any).sof_code).toBe("108");
    expect((oliver as any).fundingStatus).toBe("fundable");
    // Fixture cycles postcodes by `idx % length` — row 1 → index 1 → E1 6AN.
    expect((oliver as any).postcode_prior).toBe("E1 6AN");
    expect((oliver as any).esol_aim_type).toMatch(/regulated|non_regulated/);
    expect((oliver as any).employment_status).toMatch(
      /unemployed|employed|self_employed|not_in_labour_market/,
    );
    expect((oliver as any).lldd_health_prob).toBeOneOf([1, 2, 9]);
    expect((oliver as any).esolOnboardedAt).toBeInstanceOf(Date);
    expect((oliver as any).cohort_status).toBe("new");

    // ── Spot-check the ZZ99 learner (manual_review path) ─────────
    const zz99 = learners.find(
      (l) => (l as any).postcode_prior === POSTCODE_NOT_IN_DATASET,
    );
    expect(zz99).toBeTruthy();
    expect((zz99 as any).sof_code).toBeNull();
    expect((zz99 as any).fundingStatus).toBe("manual_review");

    // ── AuditLog: 46 learner_bulk_imported rows, all by this actor ─
    const auditRows = await AuditLog.find({
      org_id: org._id,
      action: "learner_bulk_imported",
    }).lean();
    expect(auditRows).toHaveLength(46);
    for (const a of auditRows) {
      expect(a.actor_type).toBe("org_admin");
      expect(String(a.actor_id)).toBe(actor._id.toString());
      expect(a.reason).toBe("Bulk import via CSV upload");
    }

    // ── Manual-review batch notification fired once per org_admin ─
    // Single actor in this test → exactly one notification.
    expect(mockedNotify).toHaveBeenCalledTimes(1);
    expect(mockedNotify.mock.calls[0][0]).toMatchObject({
      type: "system",
      data: expect.objectContaining({
        reason: "postcode_not_in_dataset",
        source: "bulk_import",
        manual_review_count: 1,
      }),
    });
  });
});

// Jest's `toBeOneOf` isn't built in — tiny custom matcher for the
// spot-check above. Lives here rather than a separate setup file
// because it's the only place we need it.
expect.extend({
  toBeOneOf(received: unknown, allowed: unknown[]) {
    const pass = allowed.includes(received as never);
    return {
      pass,
      message: () =>
        `expected ${JSON.stringify(received)} ${
          pass ? "not " : ""
        }to be one of ${JSON.stringify(allowed)}`,
    };
  },
});
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toBeOneOf(allowed: unknown[]): R;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// D2-2 — idempotent re-upload
// ─────────────────────────────────────────────────────────────────────

describe("D2-2 — corrected re-upload is idempotent against the original 45", () => {
  it("imports 4 fixed rows fresh, treats the corrected ZZ99 row as a duplicate, never re-creates the 45 originals", async () => {
    const org = await createOrg();
    const actor = await createActor(org._id);

    // ── Step 1: original upload ──────────────────────────────────
    await importLearnersService(
      csvToFile(generateOriginalCsv()),
      org._id.toString(),
      actor._id.toString(),
    );
    const afterOriginal = await User.countDocuments({
      orgId: org._id,
      role: "student",
    });
    expect(afterOriginal).toBe(46);

    // The idempotency store has exactly 46 rows tagged for this org's
    // bulk import — one per successfully-committed row.
    const idempRows = await IdempotencyKey.find({
      org_id: org._id,
      operation: "learner-bulk-import",
    }).lean();
    expect(idempRows).toHaveLength(46);

    // ── Step 2: corrected re-upload ──────────────────────────────
    const correctedRes = await importLearnersService(
      csvToFile(generateCorrectedCsv()),
      org._id.toString(),
      actor._id.toString(),
    );
    const correctedSummary = correctedRes.data as {
      total: number;
      imported: number;
      failed: number;
      duplicate: number;
      errors: unknown[];
      warnings: unknown[];
    };

    expect(correctedSummary.total).toBe(5);
    // 4 hard-failure rows had no prior idempotency row → fresh imports.
    expect(correctedSummary.imported).toBe(4);
    // 1 row (ZZ99 → fixed postcode) collides with the cached key — the
    // service returns the prior result and counts it as a duplicate.
    expect(correctedSummary.duplicate).toBe(1);
    expect(correctedSummary.failed).toBe(0);
    expect(correctedSummary.errors).toHaveLength(0);
    // No new manual_review hits → no warning on the corrected run.
    expect(correctedSummary.warnings).toHaveLength(0);

    // ── Step 3: invariants ───────────────────────────────────────
    const finalCount = await User.countDocuments({
      orgId: org._id,
      role: "student",
    });
    // 45 originals + 1 ZZ99 + 4 corrected hard-failure rows = 50.
    // Crucially NOT 91 (no re-creation of the 45) and NOT 51 (the
    // corrected ZZ99 row didn't create a parallel learner).
    expect(finalCount).toBe(50);

    // The original 45 learners' emails are untouched — each appears
    // exactly once.
    for (let i = 1; i <= 50; i += 1) {
      const isProblemRow =
        i === PROBLEM_ROWS.MISSING_LLDD ||
        i === PROBLEM_ROWS.BAD_DATE ||
        i === PROBLEM_ROWS.INVALID_LEVEL ||
        i === PROBLEM_ROWS.POSTCODE_NOT_IN_DATASET ||
        i === PROBLEM_ROWS.INVALID_AIM_TYPE;
      const count = await User.countDocuments({
        email: `learner-${i}@test-import.local`,
      });
      // Every row should exist exactly once after the corrected upload.
      // Problem rows that hard-failed appear once (from corrected run);
      // valid rows + ZZ99 also appear once (from original run).
      expect(count).toBe(1);

      // The ZZ99 learner's postcode is still the original sentinel —
      // idempotency cached the prior result rather than overwriting.
      // This is the documented invariant; if you want to UPDATE a
      // learner, use the PATCH /api/esol/learners/:id endpoint, not
      // a re-import.
      if (i === PROBLEM_ROWS.POSTCODE_NOT_IN_DATASET) {
        const u = await User.findOne({
          email: `learner-${i}@test-import.local`,
        }).lean();
        expect((u as any).postcode_prior).toBe(POSTCODE_NOT_IN_DATASET);
        expect((u as any).fundingStatus).toBe("manual_review");
      }
    }

    // IdempotencyKey collection grew by exactly 4 — one per fresh
    // commit. The cached ZZ99 row was a lookup, not an insert.
    const finalIdemp = await IdempotencyKey.countDocuments({
      org_id: org._id,
      operation: "learner-bulk-import",
    });
    expect(finalIdemp).toBe(46 + 4);
  });
});
