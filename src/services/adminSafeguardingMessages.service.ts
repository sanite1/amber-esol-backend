/**
 * Amber-admin safeguarding response-text CMS — Final Addendum §2.
 *
 *   GET /api/admin/safeguarding-messages      full bank + option lists
 *   PUT /api/admin/safeguarding-messages      upsert one (category, language) text
 *
 * Every edit upserts the Mongo row, rebuilds the in-memory bank (the
 * pre-cache the live safeguarding path reads — no deployment needed),
 * and writes an audit row capturing before/after text. Safeguarding
 * texts are learner-crisis copy: the audit trail matters as much here
 * as in the funding pipeline.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import SafeguardingMessage from "../models/SafeguardingMessage";
import {
  reloadSafeguardingBankFromDb,
  getSafeguardingBankSnapshot,
} from "./safeguardingMessages.service";
import { writeAuditLog } from "./auditLog.service";

const CATEGORIES = [
  "self_harm",
  "domestic_abuse",
  "radicalisation",
  "child_concern",
  "exploitation",
  "mental_health_crisis",
] as const;

const LANGUAGES = ["en", "ar", "so", "fa", "zh"] as const;

export const listSafeguardingMessagesService =
  async (): Promise<ApiResponse> => {
    // Ensure the collection is seeded + the snapshot is fresh before
    // the editor reads it (first call after a clean deploy).
    await reloadSafeguardingBankFromDb();
    return new ApiResponse(200, "Safeguarding messages", {
      bank: getSafeguardingBankSnapshot(),
      categories: CATEGORIES,
      languages: LANGUAGES,
    });
  };

export interface UpdateSafeguardingMessageBody {
  category?: string;
  language?: string;
  text?: string;
}

export const updateSafeguardingMessageService = async (
  body: UpdateSafeguardingMessageBody,
  callerId: string,
): Promise<ApiResponse> => {
  const category = String(body.category ?? "").trim();
  const language = String(body.language ?? "").trim();
  const text = typeof body.text === "string" ? body.text.trim() : null;

  if (!(CATEGORIES as readonly string[]).includes(category)) {
    throw new ApiError(
      400,
      `category must be one of: ${CATEGORIES.join(", ")}`,
    );
  }
  if (!(LANGUAGES as readonly string[]).includes(language)) {
    throw new ApiError(400, `language must be one of: ${LANGUAGES.join(", ")}`);
  }
  if (text === null) {
    throw new ApiError(
      400,
      "text is required (may be empty to fall back to English)",
    );
  }
  if (text.length > 2000) {
    throw new ApiError(400, "text must be 2000 characters or fewer");
  }
  // English is the universal fall-back — it can be edited but never
  // emptied, or the fall-back chain would bottom out on the
  // hard-coded last-resort for every learner.
  if (language === "en" && text.length === 0) {
    throw new ApiError(
      400,
      "The English text cannot be empty — it is the fall-back for every other language",
    );
  }

  const prior = await SafeguardingMessage.findOne({
    category,
    language,
  }).lean();

  await SafeguardingMessage.updateOne(
    { category, language },
    {
      $set: {
        text,
        updated_by: Types.ObjectId.isValid(callerId)
          ? new Types.ObjectId(callerId)
          : null,
        updated_at: new Date(),
      },
    },
    { upsert: true },
  );

  // Rebuild the live in-memory bank — the whole point of the CMS.
  await reloadSafeguardingBankFromDb();

  await writeAuditLog({
    actor_type: "amber_admin",
    actor_id: callerId,
    org_id: null,
    learner_id: null,
    action: "safeguarding_message_updated",
    before_state: { category, language, text: prior?.text ?? null },
    after_state: { category, language, text },
    reason: `Safeguarding response text updated — ${category} / ${language} (${text.length} chars).`,
    compliance_config_version: null,
  });

  return new ApiResponse(200, "Safeguarding message updated", {
    category,
    language,
    text,
  });
};
