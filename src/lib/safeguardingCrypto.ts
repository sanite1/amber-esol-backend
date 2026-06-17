import Cryptr from "cryptr";
import logger from "../config/logger";

/**
 * Encrypt / decrypt the RAW text of a safeguarding disclosure at rest
 * (F22 hardening — "rawInputEncrypted, encrypted at rest, access-
 * controlled").
 *
 * The raw words a learner used in a disclosure are the most sensitive
 * data the platform holds. They must never sit in the database in
 * cleartext. This module encrypts them with cryptr (AES-256-GCM) under
 * a DEDICATED key, separate from MIS credentials, so the two blast
 * radii don't overlap.
 *
 * FAIL-SAFE, not fail-closed (the opposite of misCredentials):
 *   - Safeguarding must NEVER break for want of a key. If
 *     SAFEGUARDING_ENCRYPTION_KEY is missing/short, encrypt() returns
 *     null and logs a warning ONCE — the caller then keeps the existing
 *     behaviour (raw stays in the append-only TurnLog) rather than
 *     losing the disclosure. A learner in crisis still gets supported.
 *   - When the key IS set, the raw is stored encrypted on the
 *     SafeguardingAlert and redacted out of TurnLog, so no plaintext
 *     copy exists anywhere.
 *
 * Generate a key:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * then set SAFEGUARDING_ENCRYPTION_KEY in .env + Vercel.
 */

const MIN_KEY_LENGTH = 32;

let _cryptr: Cryptr | null = null;
let _warned = false;

const getCryptr = (): Cryptr | null => {
  if (_cryptr) return _cryptr;
  const key = process.env.SAFEGUARDING_ENCRYPTION_KEY;
  if (!key || key.length < MIN_KEY_LENGTH) {
    if (!_warned) {
      _warned = true;
      logger.warn(
        "SAFEGUARDING_ENCRYPTION_KEY missing/short — safeguarding raw input " +
          "will NOT be encrypted (kept in the append-only TurnLog instead). " +
          "Set a 32-byte hex key before pilot to encrypt disclosures at rest.",
      );
    }
    return null;
  }
  _cryptr = new Cryptr(key);
  return _cryptr;
};

/** Encrypt raw disclosure text. Returns null when no key is configured. */
export const encryptSafeguardingRaw = (plaintext: string): string | null => {
  const c = getCryptr();
  if (!c) return null;
  try {
    return c.encrypt(plaintext);
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "Safeguarding raw encryption failed — falling back to no-store",
    );
    return null;
  }
};

/** Decrypt for an authorised DSL read. Returns null on any failure. */
export const decryptSafeguardingRaw = (ciphertext: string): string | null => {
  const c = getCryptr();
  if (!c) return null;
  try {
    return c.decrypt(ciphertext);
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "Safeguarding raw decryption failed",
    );
    return null;
  }
};

/** Test-only — reset the memoised client + warning latch. */
export const __resetSafeguardingCryptoForTests = (): void => {
  _cryptr = null;
  _warned = false;
};
