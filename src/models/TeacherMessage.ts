import { Schema, model } from "mongoose";
import { ITeacherMessage } from "../interfaces/teacherMessage.interface";

/**
 * TeacherMessage — short in-product messages from teacher to learner.
 *
 * Used by the teacher-multiplier UI for nudges, re-engagement notes,
 * priority-queue-prompted check-ins, and automated cron-driven outreach.
 * The 300-char limit is deliberate: long-form coaching belongs in a
 * contact_session, not a one-way message.
 *
 * `trigger` records what produced the message so we can later measure
 * which trigger paths actually move learners (priority_queue vs cron vs
 * manual). Per-learner read receipts are tracked via `read_at`.
 *
 * Language defaults to the learner's l1_language at send time. We don't
 * snapshot the language onto every message because translation/sending
 * happens at delivery — the teacher writes in English; the platform may
 * later auto-translate.
 */

const teacherMessageSchema = new Schema<ITeacherMessage>(
  {
    teacher_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    learner_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
    },
    message_text: {
      type: String,
      required: true,
      // Input is validated to 1-300 at the route layer. The schema
      // cap is set at 600 to leave headroom for L1 translations,
      // which can expand 1.5-2x in Arabic / Persian / Pashto. The
      // ORIGINAL text stays inside the 300-char input budget; only
      // the translated `message_text` ever uses the headroom.
      maxlength: 600,
      trim: true,
    },
    /**
     * Final Addendum §11 — preserves the teacher's English input
     * when `message_text` carries an L1 translation. Null when the
     * message was sent untranslated. The pair lets the audit-log
     * UI render "Teacher wrote (en): … / Learner received (ar): …"
     * without re-derivation.
     */
    original_text: {
      type: String,
      default: null,
      maxlength: 300,
      trim: true,
    },
    language: {
      // ISO-ish code: "en", "ar", "so", "fa-AF", "ps", "zh-HK"
      // Filled from User.l1Language at create time by the service.
      type: String,
      default: "en",
    },
    sent_at: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    read_at: {
      type: Date,
      default: null,
    },
    trigger: {
      type: String,
      enum: ["manual", "priority_queue", "re_engagement_cron"],
      required: true,
      default: "manual",
    },
  },
  {
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: false },
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  },
);

// Most common queries: "what messages has THIS learner got?" and
// "what has THIS teacher sent recently?"
teacherMessageSchema.index({ learner_id: 1, sent_at: -1 });
teacherMessageSchema.index({ teacher_id: 1, sent_at: -1 });
teacherMessageSchema.index({ org_id: 1, sent_at: -1 });

const TeacherMessage = model<ITeacherMessage>(
  "TeacherMessage",
  teacherMessageSchema,
);

export default TeacherMessage;
