/**
 * Deterministic eligibility engine for ESOL learner funding status.
 * No AI involved — pure rule-based logic per the v2 spec D1.
 */

export type FundingStatus = "fundable" | "self_pay" | "manual_review";

const REQUIRED_RESIDENCY_MONTHS = 6;
const OCR_CONFIDENCE_THRESHOLD = 0.8;

export const computeFundingStatus = (params: {
  residencyDate: Date | null;
  ocrConfidence: number;
}): FundingStatus => {
  if (params.ocrConfidence < OCR_CONFIDENCE_THRESHOLD) {
    return "manual_review";
  }
  if (!params.residencyDate) {
    return "manual_review";
  }

  const monthsResident =
    (Date.now() - params.residencyDate.getTime()) /
    (1000 * 60 * 60 * 24 * 30.44);

  if (monthsResident >= REQUIRED_RESIDENCY_MONTHS) {
    return "fundable";
  }
  return "self_pay";
};
