/**
 * Phase 1.3 hardening — raw-disclosure encryption + alert immutability.
 */
import { Types } from "mongoose";
import SafeguardingAlert from "../models/SafeguardingAlert";
import {
  encryptSafeguardingRaw,
  decryptSafeguardingRaw,
  __resetSafeguardingCryptoForTests,
} from "../lib/safeguardingCrypto";

describe("safeguardingCrypto", () => {
  afterEach(() => {
    delete process.env.SAFEGUARDING_ENCRYPTION_KEY;
    __resetSafeguardingCryptoForTests();
  });

  it("round-trips raw disclosure when a key is set, and never stores cleartext", () => {
    process.env.SAFEGUARDING_ENCRYPTION_KEY = "a".repeat(64);
    __resetSafeguardingCryptoForTests();
    const raw = "I want to hurt myself";
    const cipher = encryptSafeguardingRaw(raw);
    expect(cipher).toBeTruthy();
    expect(cipher).not.toContain("hurt"); // ciphertext is not cleartext
    expect(decryptSafeguardingRaw(cipher as string)).toBe(raw);
  });

  it("fails SAFE (returns null, no throw) when no key is configured", () => {
    __resetSafeguardingCryptoForTests();
    expect(encryptSafeguardingRaw("disclosure")).toBeNull();
    expect(decryptSafeguardingRaw("anything")).toBeNull();
  });
});

describe("SafeguardingAlert immutability", () => {
  it("ignores updates to immutable disclosure-core fields, allows status/review lifecycle", async () => {
    const learnerId = new Types.ObjectId();
    const orgId = new Types.ObjectId();
    const sessionId = new Types.ObjectId();
    const hash = "a".repeat(64);

    const alert = await SafeguardingAlert.create({
      learnerId,
      orgId,
      sessionId,
      alertLevel: "critical",
      messageContentHash: hash,
      rawInputEncrypted: "cipher-xyz",
      triggerCategory: "self_harm",
      triggerSource: "keyword",
      status: "open",
    });

    // Attempt to mutate immutable core + a legitimately mutable field.
    await SafeguardingAlert.updateOne(
      { _id: alert._id },
      {
        $set: {
          alertLevel: "low", // immutable — must be ignored
          messageContentHash: "b".repeat(64), // immutable — ignored
          triggerCategory: "domestic_abuse", // immutable — ignored
          status: "reviewed", // mutable — must apply
          reviewedAt: new Date(), // mutable — must apply
        },
      },
    );

    const after = await SafeguardingAlert.findById(alert._id).lean();
    expect(after!.alertLevel).toBe("critical"); // unchanged
    expect(after!.messageContentHash).toBe(hash); // unchanged
    expect(after!.triggerCategory).toBe("self_harm"); // unchanged
    expect(after!.status).toBe("reviewed"); // changed
    expect(after!.reviewedAt).toBeTruthy(); // changed
  });
});
