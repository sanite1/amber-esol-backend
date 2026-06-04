/**
 * MIS adapter framework — Final Addendum §7 / Phase 21.
 *
 * Test plan
 * =========
 *
 *   U1   ProSolution payload transform — MISRecord → ProSolution wire
 *        fields via FIELD_MAP, raw_payload overrides typed fields,
 *        HTTP client called with correct URL + headers + body
 *   U2   Maytas payload transform — buildCsv produces correctly-
 *        escaped header + rows in MAYTAS_CSV_COLUMNS order; method
 *        bodies still throw NotImplementedError today
 *   U3   EBS payload transform — toEBSPayload maps via EBS_FIELD_MAP;
 *        method bodies throw NotImplementedError today
 *
 *   F1   AdapterFactory: returns ProSolutionAdapter for misType "ProSolution"
 *   F2   AdapterFactory: returns MaytasAdapter for "Maytas"
 *   F3   AdapterFactory: returns EBSAdapter for "EBS"
 *   F4   AdapterFactory: throws MISNotConfiguredError on "none"
 *   F5   AdapterFactory: throws MISNotConfiguredError when credentials missing
 *
 *   I1   Idempotency: enqueue the same single push twice via
 *        IdempotencyService.check; assert the adapter is called once
 *   I2   Idempotency: batch-key sorts ULNs before hashing so two
 *        callers with the same set in different orders dedupe
 *
 *   V1   Validation: a learner with an invalid SOF code is HELD
 *        (mis_push_held audit row) before any adapter call
 *   V2   Validation: a valid record passes through and reaches the
 *        adapter
 *
 *   C1   Credential encryption: encryptMisCredentials writes ciphertext
 *        to Organisation.misApiCredentials (round-trips ≠ plaintext)
 *   C2   Credential encryption: AdapterFactory decrypts and the
 *        adapter receives the original plaintext via the construct
 *        config
 */

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret";
process.env.MIS_CREDENTIALS_KEY =
  process.env.MIS_CREDENTIALS_KEY ??
  // 64 hex chars (32 bytes) — satisfies the MIN_KEY_LENGTH guard
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// `../queues` constructs BullMQ Queues at module load — needs a
// REDIS_URL we don't have in the test env. Mock the module wholesale.
// processMisPush.ts imports notificationsQueue from here; the other
// queue exports are touched only if delta-sync / etc tests run.
jest.mock("../queues", () => {
  const noopAdd = jest.fn().mockResolvedValue({ id: "fake-job-id" });
  return {
    __esModule: true,
    notificationsQueue: { add: noopAdd },
    deltaSyncQueue: { add: noopAdd },
    misPushQueue: { add: noopAdd },
    complianceValidationQueue: { add: noopAdd },
    rarpaEvidenceQueue: { add: noopAdd },
    ilrExportQueue: { add: noopAdd },
    priorityQueueQueue: { add: noopAdd },
    esolSessionQueue: { add: noopAdd },
    cacheRefreshQueue: { add: noopAdd },
    allQueues: {},
  };
});

import mongoose, { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import ComplianceConfig from "../models/ComplianceConfig";
import ComplianceConfigService from "../services/ComplianceConfigService";
import {
  encryptMisCredentials,
  decryptMisCredentials,
  __resetForTests as resetCryptr,
} from "../lib/misCredentials";
import { getAdapter } from "../services/mis/AdapterFactory";
import {
  ProSolutionAdapter,
  createProSolutionAdapter,
  __internals__ as proInternals,
} from "../services/mis/ProSolutionAdapter";
import {
  MaytasAdapter,
  createMaytasAdapter,
  __internals__ as maytasInternals,
} from "../services/mis/MaytasAdapter";
import {
  EBSAdapter,
  createEBSAdapter,
  __internals__ as ebsInternals,
} from "../services/mis/EBSAdapter";
import {
  MISNotConfiguredError,
  NotImplementedError,
  type MISRecord,
} from "../services/mis/types";
import { validateMisRecord } from "../services/mis/validateMisRecord";
import IdempotencyService from "../services/idempotency.service";
import { __internals__ as misPushInternals } from "../services/mis/processMisPush";

// ─────────────────────────────────────────────────────────────────────
// Setup — Mongo via the shared in-memory server (src/__tests__/setup.ts)
// is loaded by jest.config; we don't re-declare beforeAll here.
//
// Each test gets a clean DB via the global afterEach hook in setup.ts.
// Reset the cryptr singleton too so a test that mutates the key env
// var gets a fresh client.
// ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  resetCryptr();
  // Compliance config in-memory cache also needs clearing between
  // tests that prime different rule sets.
  ComplianceConfigService.__resetCacheForTests();
});

// ─────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────

const makeOrg = async (overrides: Partial<Record<string, unknown>> = {}) => {
  return Organisation.create({
    name: "Test Org",
    slug: `test-org-${Date.now()}-${Math.random()}`,
    paymentModel: "invoiced",
    invoiceCycle: "monthly",
    misType: "ProSolution",
    misApiEndpoint: "https://prosolution.example.com",
    // Stored encrypted — tests that assert decrypted behaviour go
    // through encryptMisCredentials so the schema matches reality.
    misApiCredentials: encryptMisCredentials("test-api-key-1234"),
    billing_active: true,
    ...overrides,
  });
};

const baseRecord = (overrides: Partial<MISRecord> = {}): MISRecord => ({
  uln: "1234567890",
  firstname: "Aisha",
  lastname: "Khan",
  date_of_birth: "1990-05-12",
  esol_level: "e2",
  learn_start_date: "2025-09-01",
  learn_plan_end_date: "2026-06-30",
  learn_act_end_date: null,
  outcome: 8,
  comp_status: 1,
  sof: "105",
  add_hours: 0,
  english_prog_type: "25",
  total_glh: 36.5,
  skill_codes_covered: ["Sc", "Lr"],
  raw_payload: {},
  ...overrides,
});

const primeIlrConfig = async (overrides: Record<string, unknown> = {}) => {
  // Plain 2025/26 rule bag with permissive defaults; tests that
  // want a specific value to fail override per-test.
  await ComplianceConfig.create({
    domain: "ilr",
    academic_year: "2025/26",
    version: 1,
    active: true,
    rules: {
      valid_outcomes: [1, 2, 3, 8],
      valid_comp_statuses: [1, 2, 3, 6],
      valid_sof_codes: ["105", "107"],
      valid_english_prog_types: ["25"],
      ...overrides,
    },
  });
  await ComplianceConfigService.loadAll();
};

// ─────────────────────────────────────────────────────────────────────
// U1 — ProSolution payload transform
// ─────────────────────────────────────────────────────────────────────

describe("ProSolutionAdapter — payload transform (U1)", () => {
  it("maps MISRecord field names to ProSolution wire names via FIELD_MAP", () => {
    const record = baseRecord();
    const payload = proInternals.toProSolutionPayload(record);
    // Spot-check several mappings against the FIELD_MAP definition
    expect(payload).toMatchObject({
      ULN: "1234567890",
      FirstName: "Aisha",
      LastName: "Khan",
      DateOfBirth: "1990-05-12",
      ESOLLevel: "e2",
      LearnStartDate: "2025-09-01",
      Outcome: 8,
      CompStatus: 1,
      SOF: "105",
      TotalGLH: 36.5,
      SkillCodes: ["Sc", "Lr"],
    });
  });

  it("raw_payload overrides typed fields after the typed mapping", () => {
    const record = baseRecord({
      raw_payload: { ULN: "OVERRIDE", ExtraCustomField: "yes" },
    });
    const payload = proInternals.toProSolutionPayload(record) as Record<
      string,
      unknown
    >;
    expect(payload.ULN).toBe("OVERRIDE");
    expect(payload.ExtraCustomField).toBe("yes");
  });

  it("calls fetch with correct URL, Bearer auth, and JSON-stringified body", async () => {
    // Stub the global fetch — Node 22 provides it; jest replaces.
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      // adapter calls .text() then JSON.parse — return a stringified body
      text: async () => JSON.stringify({ id: "ps-record-001" }),
    });
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const adapter = createProSolutionAdapter({
      endpoint: "https://prosolution.example.com",
      credentials: "secret-token",
      org_id: new Types.ObjectId().toString(),
    });
    const result = await adapter.pushLearner(baseRecord());

    expect(result.success).toBe(true);
    expect(result.provider_record_id).toBe("ps-record-001");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://prosolution.example.com/api/learners");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      }),
    });
    const body = JSON.parse(init.body as string);
    expect(body.ULN).toBe("1234567890");
  });
});

// ─────────────────────────────────────────────────────────────────────
// U2 — Maytas CSV transform
// ─────────────────────────────────────────────────────────────────────

describe("MaytasAdapter — CSV transform (U2)", () => {
  it("buildCsv emits header in MAYTAS_CSV_COLUMNS order", () => {
    const csv = maytasInternals.buildCsv([baseRecord()]);
    const [header] = csv.split("\n");
    const expected = maytasInternals.MAYTAS_CSV_COLUMNS.map((c) =>
      maytasInternals.csvCell(c.csvHeader),
    ).join(",");
    expect(header).toBe(expected);
  });

  it("csvCell escapes commas, quotes, and newlines per RFC 4180", () => {
    expect(maytasInternals.csvCell("plain")).toBe("plain");
    expect(maytasInternals.csvCell("with, comma")).toBe('"with, comma"');
    expect(maytasInternals.csvCell('with "quote"')).toBe('"with ""quote"""');
    expect(maytasInternals.csvCell("with\nnewline")).toBe('"with\nnewline"');
    expect(maytasInternals.csvCell(null)).toBe("");
    expect(maytasInternals.csvCell(["a", "b", "c"])).toBe("a|b|c");
  });

  it("buildCsvRow places fields in column order with values from the record", () => {
    const row = maytasInternals.buildCsvRow(baseRecord());
    const cells = row.split(",");
    // Spot-check first three columns by their MAYTAS_CSV_COLUMNS index
    expect(cells[0]).toBe("1234567890"); // ULN
    expect(cells[1]).toBe("Aisha"); // GivenNames
    expect(cells[2]).toBe("Khan"); // FamilyName
  });

  it("method bodies throw NotImplementedError until activation", async () => {
    const adapter = createMaytasAdapter({
      endpoint: "sftp://drop.example.com",
      credentials: "k",
      org_id: new Types.ObjectId().toString(),
    });
    await expect(adapter.testConnection()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(adapter.pushLearner(baseRecord())).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      adapter.pushBatch([baseRecord()]),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      adapter.pullLearnerStatus("1234567890"),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ─────────────────────────────────────────────────────────────────────
// U3 — EBS payload transform
// ─────────────────────────────────────────────────────────────────────

describe("EBSAdapter — payload transform (U3)", () => {
  it("toEBSPayload maps via EBS_FIELD_MAP (lowercase + underscores style)", () => {
    const payload = ebsInternals.toEBSPayload(baseRecord());
    expect(payload).toMatchObject({
      uln: "1234567890",
      given_name: "Aisha",
      family_name: "Khan",
      dob: "1990-05-12",
      qualification_level: "e2",
      enrollment_date: "2025-09-01",
      outcome_code: 8,
      funding_source: "105",
    });
  });

  it("method bodies throw NotImplementedError until activation", async () => {
    const adapter = createEBSAdapter({
      endpoint: "https://capita.example.com",
      credentials: "k",
      org_id: new Types.ObjectId().toString(),
    });
    await expect(adapter.testConnection()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(adapter.pushLearner(baseRecord())).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// F1-F5 — AdapterFactory dispatch
// ─────────────────────────────────────────────────────────────────────

describe("AdapterFactory.getAdapter (F1-F5)", () => {
  it("F1: returns a ProSolutionAdapter for misType=ProSolution", async () => {
    const org = await makeOrg({ misType: "ProSolution" });
    const adapter = await getAdapter(org._id.toString());
    expect(adapter).toBeInstanceOf(ProSolutionAdapter);
  });

  it("F2: returns a MaytasAdapter for misType=Maytas", async () => {
    const org = await makeOrg({
      misType: "Maytas",
      misApiEndpoint: "sftp://drop.example.com",
    });
    const adapter = await getAdapter(org._id.toString());
    expect(adapter).toBeInstanceOf(MaytasAdapter);
  });

  it("F3: returns an EBSAdapter for misType=EBS", async () => {
    const org = await makeOrg({
      misType: "EBS",
      misApiEndpoint: "https://capita.example.com",
    });
    const adapter = await getAdapter(org._id.toString());
    expect(adapter).toBeInstanceOf(EBSAdapter);
  });

  it("F4: throws MISNotConfiguredError when misType is none", async () => {
    const org = await makeOrg({
      misType: "none",
      misApiEndpoint: null,
      misApiCredentials: null,
    });
    await expect(getAdapter(org._id.toString())).rejects.toMatchObject({
      name: "MISNotConfiguredError",
      reason: "no_mis_type",
    });
  });

  it("F5: throws MISNotConfiguredError when credentials missing", async () => {
    const org = await makeOrg({
      misType: "ProSolution",
      misApiEndpoint: "https://prosolution.example.com",
      misApiCredentials: null,
    });
    await expect(getAdapter(org._id.toString())).rejects.toMatchObject({
      name: "MISNotConfiguredError",
      reason: "no_credentials",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// I1, I2 — Idempotency
// ─────────────────────────────────────────────────────────────────────

describe("Idempotency (I1, I2)", () => {
  it("I1: enqueuing the same push twice runs the work only once", async () => {
    const key = "test-idempotency-key-i1";
    const work = jest.fn().mockResolvedValue({ pushed: 1 });

    const first = await IdempotencyService.check(key, "mis-push", work);
    const second = await IdempotencyService.check(key, "mis-push", work);

    expect(work).toHaveBeenCalledTimes(1);
    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(second.result).toEqual({ pushed: 1 });
  });

  it("I2: batch idempotency key sorts ULNs so order doesn't matter", () => {
    const orgId = new Types.ObjectId().toString();
    const a = misPushInternals.batchIdempotencyKey(orgId, [
      "1111111111",
      "2222222222",
      "3333333333",
    ]);
    const b = misPushInternals.batchIdempotencyKey(orgId, [
      "3333333333",
      "1111111111",
      "2222222222",
    ]);
    expect(a).toBe(b);
  });

  it("I2 (continued): single-key and batch-key are distinct surfaces", () => {
    const orgId = new Types.ObjectId().toString();
    const single = misPushInternals.singleIdempotencyKey(orgId, "1111111111");
    const batch = misPushInternals.batchIdempotencyKey(orgId, ["1111111111"]);
    expect(single).not.toBe(batch); // different suffixes
  });
});

// ─────────────────────────────────────────────────────────────────────
// V1, V2 — Validation gating
// ─────────────────────────────────────────────────────────────────────

describe("Validation gating (V1, V2)", () => {
  it("V1: invalid SOF code is HELD by the validator before any adapter call", async () => {
    await primeIlrConfig({
      valid_sof_codes: ["999"], // SOF "105" on the record is now invalid
    });

    const record = baseRecord(); // sof: "105" — now invalid
    const result = validateMisRecord(record);

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("Source-of-funding code")]),
    );
    // The processMisPush worker's `buildAndValidate` partition is
    // what stops the adapter being called. We verify the validator's
    // valid:false here; the worker integration uses that to skip the
    // adapter call (see I1 above for the idempotency path that runs
    // the work, and processMisPush.ts source for the partition).
  });

  it("V2: a record matching the active config passes", async () => {
    await primeIlrConfig(); // permissive defaults that match baseRecord()
    const result = validateMisRecord(baseRecord());
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.compliance_config_version).toBe(1);
  });

  it("V2 (mis_push_held audit trail): can write the held audit row", async () => {
    // Sanity that the AuditAction enum accepts mis_push_held — guards
    // against a future schema enum drift breaking the worker silently.
    await primeIlrConfig();
    const orgId = new Types.ObjectId();
    await AuditLog.create({
      timestamp: new Date(),
      actor_type: "system",
      actor_id: null,
      org_id: orgId,
      learner_id: null,
      action: "mis_push_held",
      before_state: null,
      after_state: { uln: "1234567890", reasons: ["test"] },
      reason: "test",
    });
    const row = await AuditLog.findOne({ org_id: orgId }).lean();
    expect(row?.action).toBe("mis_push_held");
  });
});

// ─────────────────────────────────────────────────────────────────────
// C1, C2 — Credential encryption
// ─────────────────────────────────────────────────────────────────────

describe("Credential encryption at rest (C1, C2)", () => {
  it("C1: misApiCredentials is encrypted at rest (not equal to plaintext)", async () => {
    const plaintext = "my-super-secret-mis-key";
    const org = await makeOrg({
      misApiCredentials: encryptMisCredentials(plaintext),
    });
    // Re-read raw via the Mongo driver — bypassing the model's
    // toJSON transform that would strip the field.
    const raw = await mongoose.connection.db!
      .collection(Organisation.collection.name)
      .findOne({ _id: org._id as Types.ObjectId });
    expect(raw?.misApiCredentials).toBeTruthy();
    expect(raw?.misApiCredentials).not.toBe(plaintext);
    // Round-trip via the helper restores the plaintext.
    const decrypted = decryptMisCredentials({
      misApiCredentials: raw!.misApiCredentials as string,
    });
    expect(decrypted).toBe(plaintext);
  });

  it("C2: AdapterFactory decrypts and the adapter receives plaintext", async () => {
    const plaintext = "factory-decrypt-roundtrip-key";
    const org = await makeOrg({
      misApiCredentials: encryptMisCredentials(plaintext),
    });

    // Stub fetch so we can capture the Authorization header the
    // adapter sends — that's the proof of the decrypted value.
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ id: "ok" }),
    });
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    const adapter = await getAdapter(org._id.toString());
    await adapter.pushLearner(baseRecord());

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const auth =
      (init.headers as Record<string, string> | undefined)?.Authorization ?? "";
    expect(auth).toBe(`Bearer ${plaintext}`);
  });
});
