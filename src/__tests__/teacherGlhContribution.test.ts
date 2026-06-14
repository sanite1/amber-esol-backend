/**
 * Pins the Final Addendum §4.3 GLH contribution table. These numbers
 * feed User.glh_teacher_contact → the ILR export → the ASF funding
 * claim, so any change here is a funding-rules change and must be
 * deliberate.
 */
import {
  glhContributionHours,
  MESSAGE_CONTACT_DURATION_MINS,
} from "../services/teacherGlhContribution";

describe("glhContributionHours — addendum §4.3 table", () => {
  it("async_review earns a fixed 0.25h regardless of duration", () => {
    expect(glhContributionHours("async_review", 0)).toBe(0.25);
    expect(glhContributionHours("async_review", 90)).toBe(0.25);
  });

  it("pathway_adjustment earns a fixed 0.25h", () => {
    expect(glhContributionHours("pathway_adjustment", 0)).toBe(0.25);
  });

  it("rarpa_signoff earns a fixed 0.5h", () => {
    expect(glhContributionHours("rarpa_signoff", 0)).toBe(0.5);
  });

  it("contact_session earns actual duration / 60", () => {
    expect(glhContributionHours("contact_session", 30)).toBe(0.5);
    expect(glhContributionHours("contact_session", 0)).toBe(0);
    // Negative duration can never produce negative GLH.
    expect(glhContributionHours("contact_session", -10)).toBe(0);
  });

  it("a written teacher message credits 5 minutes of contact", () => {
    expect(
      glhContributionHours("contact_session", MESSAGE_CONTACT_DURATION_MINS),
    ).toBeCloseTo(5 / 60, 10);
  });

  it("unknown types credit nothing (defensive)", () => {
    expect(glhContributionHours("bogus_type", 60)).toBe(0);
  });
});
