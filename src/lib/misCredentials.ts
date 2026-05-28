import Cryptr from "cryptr";
import type { IOrganisation } from "../interfaces/organisation.interface";

/**
 * Encrypt / decrypt org MIS API credentials.
 *
 * Project Silk lets organisations register MIS API tokens (ProSolution,
 * Maytas, EBS) so the platform can push ILR data back into their system.
 * Those tokens are sensitive — a leaked credential lets an attacker write
 * arbitrary ILR data into a college's MIS, with real funding consequences.
 *
 * Storage policy:
 *   - Plaintext credentials never touch the database, logs, or any API
 *     response. The Organisation.misApiCredentials field stores ONLY the
 *     cryptr ciphertext (string).
 *   - Encryption is symmetric AES-256-GCM via the `cryptr` library, keyed
 *     by MIS_CREDENTIALS_KEY (32-byte hex). Rotating the key means re-
 *     encrypting every existing organisation document — there is no
 *     side-channel "old key still works" path.
 *   - The Organisation model's toJSON transform also strips
 *     misApiCredentials so it can't accidentally leak through a JSON
 *     response handler. Decryption is only ever explicit, via this module.
 *
 * Failure mode is fail-closed:
 *   - If MIS_CREDENTIALS_KEY is missing or short, BOTH encrypt and decrypt
 *     throw on first use. Phase 21 services should surface that as a
 *     500 "MIS not configured" rather than continuing with plaintext.
 */

const MIN_KEY_LENGTH = 32; // hex chars ≈ 16 bytes; brief specifies 32-byte (64 hex)

let _cryptr: Cryptr | null = null;

const getCryptr = (): Cryptr => {
  if (_cryptr) return _cryptr;

  const key = process.env.MIS_CREDENTIALS_KEY;
  if (!key || key.length < MIN_KEY_LENGTH) {
    throw new Error(
      "MIS_CREDENTIALS_KEY is missing or too short. Generate a 32-byte hex key with " +
        `\`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\` ` +
        "and set it in .env (and Vercel project settings)."
    );
  }
  _cryptr = new Cryptr(key);
  return _cryptr;
};

/**
 * Encrypt a plaintext credential string for storage on
 * Organisation.misApiCredentials.
 *
 * Use exclusively from the org-provisioning / org-settings update path.
 * Never pass a value that hasn't been re-confirmed by the org admin
 * through the UI — once encrypted we can't tell apart "API key" from
 * "user typed their personal password by mistake".
 */
export const encryptMisCredentials = (plaintext: string): string => {
  if (!plaintext) {
    throw new Error("encryptMisCredentials called with empty plaintext");
  }
  return getCryptr().encrypt(plaintext);
};

/**
 * Decrypt an organisation's stored credentials. Returns null if the field
 * is empty (org hasn't connected an MIS yet) — that's the expected state
 * for the vast majority of orgs in MVP.
 *
 * Throws on malformed ciphertext (caller should treat as "credentials
 * corrupt — re-prompt the org admin").
 */
export const decryptMisCredentials = (
  org: Pick<IOrganisation, "misApiCredentials">
): string | null => {
  if (!org.misApiCredentials) return null;
  try {
    return getCryptr().decrypt(org.misApiCredentials);
  } catch (err) {
    throw new Error(
      `Failed to decrypt misApiCredentials: ${(err as Error).message}. ` +
        "This usually means MIS_CREDENTIALS_KEY was rotated without re-encrypting stored values."
    );
  }
};

/**
 * Test-only: reset the cached Cryptr instance so tests that override
 * MIS_CREDENTIALS_KEY get a fresh client.
 */
export const __resetForTests = (): void => {
  _cryptr = null;
};
