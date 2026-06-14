/**
 * Index audit — brief Function 12 To-Do 1 refinement.
 *
 * The brief calls out two compound indexes that must exist on User
 * for the cohort table to scale:
 *
 *   { orgId: 1, cohort_status: 1 }
 *   { orgId: 1, esolLevel: 1 }
 *
 * Both are declared in src/models/User.ts and should have been
 * created in Phase 1.6. This test asserts they're actually present
 * in the running Mongo instance — a regression that removed the
 * declaration would silently fall through to a collection scan on
 * every cohort-table request, and we'd only notice when the dashboard
 * got slow.
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import User from "../models/User";

const indexHasKeys = (
  indexes: Array<Record<string, unknown>>,
  expectedKey: Record<string, number>,
): boolean =>
  indexes.some((idx) => {
    const key = idx.key as Record<string, number> | undefined;
    if (!key) return false;
    const keys = Object.keys(expectedKey);
    if (Object.keys(key).length !== keys.length) return false;
    return keys.every((k) => key[k] === expectedKey[k]);
  });

describe("User indexes — brief Function 12 refinement", () => {
  beforeAll(async () => {
    // Ensure schema-declared indexes are synced to Mongo. In normal
    // service startup Mongoose does this automatically; in the test
    // harness we trigger it explicitly so the assertions don't race.
    await User.init();
  });

  it("I1 — (orgId, cohort_status) compound index exists", async () => {
    const indexes = (await User.collection.indexes()) as Array<
      Record<string, unknown>
    >;
    expect(indexHasKeys(indexes, { orgId: 1, cohort_status: 1 })).toBe(true);
  });

  it("I2 — (orgId, esolLevel) compound index exists", async () => {
    const indexes = (await User.collection.indexes()) as Array<
      Record<string, unknown>
    >;
    expect(indexHasKeys(indexes, { orgId: 1, esolLevel: 1 })).toBe(true);
  });
});
