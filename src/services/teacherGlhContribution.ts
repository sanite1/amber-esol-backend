/**
 * GLH contribution per teacher activity — Final Addendum §4.3 / §12.
 *
 * THE single source of truth for how many Guided Learning Hours a
 * TeacherReview adds to `User.glh_teacher_contact` (which the ILR
 * export reads directly — these numbers go straight into the ASF
 * funding claim, so they must match the addendum exactly):
 *
 *   async_review        0.25 h  fixed — teacher reviewed AI data + notes
 *   contact_session     duration_mins / 60 — actual contact time
 *   pathway_adjustment  0.25 h  fixed — teacher modified the pathway
 *   rarpa_signoff       0.5  h  fixed — formal stage sign-off
 *
 * Historical note: before 2026-06-11 every type credited
 * duration_mins/60, which under-claimed async reviews, pathway
 * adjustments and sign-offs (all logged with 0 mins). Every
 * TeacherReview creation site must call this helper — never inline
 * the maths.
 */

export type TeacherReviewType =
  | "async_review"
  | "contact_session"
  | "pathway_adjustment"
  | "rarpa_signoff";

/** Standard duration logged for a written teacher message (§11). */
export const MESSAGE_CONTACT_DURATION_MINS = 5;

export const glhContributionHours = (
  review_type: TeacherReviewType | string,
  duration_mins: number,
): number => {
  switch (review_type) {
    case "async_review":
      return 0.25;
    case "pathway_adjustment":
      return 0.25;
    case "rarpa_signoff":
      return 0.5;
    case "contact_session":
      return Math.max(0, duration_mins) / 60;
    default:
      // Unknown type — credit nothing rather than guessing a funding
      // figure. The TeacherReview enum should make this unreachable.
      return 0;
  }
};
