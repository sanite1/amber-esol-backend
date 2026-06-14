/**
 * ROI calculator deep-link builder — Final Addendum §13.
 *
 * Builds the prefill URL the onboarding welcome email links to:
 *
 *   {base}/roi-calculator?org_name=…&waiting_list_size=…
 *                        &avg_asf_rate=…&org_type=…
 *                        &current_throughput_per_year=…
 *
 * Every parameter is optional — the frontend's
 * `buildRoiInitialValues` falls back to platform defaults for
 * missing or malformed values. We over-include here on the
 * server side rather than under-include, because once the email
 * lands in the org admin's inbox we can't go back and add
 * params.
 *
 * Why a separate file
 * ===================
 *
 * The org service shouldn't carry knowledge of the marketing-
 * page route shape; this module owns it. A future calculator
 * relocation (`/funding-calculator`, `/roi`, etc.) is a
 * one-line change.
 */

/**
 * Public marketing-site base. Honours an explicit env override
 * (`PUBLIC_MARKETING_URL`), then falls back to the platform's
 * brand domain. Trailing slash trimmed so concat with
 * `/roi-calculator` always yields a clean URL.
 */
const marketingBaseUrl = (): string => {
  const raw = process.env.PUBLIC_MARKETING_URL || "https://ambertraining.co.uk";
  return raw.replace(/\/+$/, "");
};

export interface RoiCalculatorPrefill {
  org_name?: string | null;
  org_type?: "college" | "council" | "charity" | "employer" | null;
  waiting_list_size?: number | null;
  avg_asf_rate?: number | null;
  current_throughput_per_year?: number | null;
}

const isPositiveFiniteNumber = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Compose the prefill URL. Every field is independently
 * validated — a null / empty / non-finite value is omitted
 * rather than serialised as an empty string (an empty
 * `?org_name=` is messy and the frontend's parser would
 * accept it but treat it as no-prefill anyway).
 */
export const buildRoiCalculatorUrl = (
  prefill: RoiCalculatorPrefill = {},
): string => {
  const params = new URLSearchParams();

  if (
    typeof prefill.org_name === "string" &&
    prefill.org_name.trim().length > 0
  ) {
    // 120-char cap mirrors the frontend's parser + the
    // submission model. Trim first so trailing whitespace
    // doesn't eat into the budget.
    params.set("org_name", prefill.org_name.trim().slice(0, 120));
  }
  if (
    prefill.org_type === "college" ||
    prefill.org_type === "council" ||
    prefill.org_type === "charity" ||
    prefill.org_type === "employer"
  ) {
    params.set("org_type", prefill.org_type);
  }
  if (isPositiveFiniteNumber(prefill.waiting_list_size)) {
    params.set(
      "waiting_list_size",
      String(Math.floor(prefill.waiting_list_size)),
    );
  }
  if (isPositiveFiniteNumber(prefill.avg_asf_rate)) {
    params.set("avg_asf_rate", String(prefill.avg_asf_rate));
  }
  if (
    typeof prefill.current_throughput_per_year === "number" &&
    Number.isFinite(prefill.current_throughput_per_year) &&
    prefill.current_throughput_per_year >= 0
  ) {
    params.set(
      "current_throughput_per_year",
      String(Math.floor(prefill.current_throughput_per_year)),
    );
  }

  const qs = params.toString();
  const base = `${marketingBaseUrl()}/roi-calculator`;
  return qs.length > 0 ? `${base}?${qs}` : base;
};

export const __internals__ = { marketingBaseUrl, isPositiveFiniteNumber };
