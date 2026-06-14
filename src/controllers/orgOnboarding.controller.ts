/**
 * Org-admin onboarding controller — Phase 2 / Final Addendum §13 (BE-G).
 *
 * Two endpoints:
 *   GET  /api/org-admin/onboarding/status     -> getOrgOnboardingStatus
 *   POST /api/org-admin/onboarding/complete   -> markOrgOnboardingComplete
 *
 * Both routes sit behind the standard org-admin auth chain
 * (isAuthenticated + isOrgAdmin + requireOrgContext) configured at
 * the router level. By the time we reach this controller,
 * `req.esol_context.org_id` is set.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  getOrgOnboardingStatusService,
  markOrgOnboardingCompleteService,
} from "../services/orgOnboarding.service";

const readOrgId = (req: {
  esol_context?: { org_id?: string };
  user?: { orgId?: string | null };
}): string =>
  req.esol_context?.org_id ??
  (req.user?.orgId as string | null | undefined) ??
  "";

export const getOrgOnboardingStatus: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const orgId = readOrgId(
      req as typeof req & {
        esol_context?: { org_id?: string };
      },
    );
    const result = await getOrgOnboardingStatusService(orgId);
    return res
      .status(result.statusCode)
      .json({ message: result.message, data: result.data });
  } catch (err) {
    next(err);
  }
};

export const markOrgOnboardingComplete: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const orgId = readOrgId(
      req as typeof req & {
        esol_context?: { org_id?: string };
      },
    );
    const actorUserId =
      (req.user?.id as string | undefined) ??
      (req.user?._id as string | undefined) ??
      "";

    // Body accepts an optional `source` to flavour the audit reason.
    // We default to "skipped" when absent — the frontend always sends
    // either "roi_calculator_submitted" or "skipped"; the default
    // matters only for a misbehaving client.
    const body = (req.body ?? {}) as { source?: string };
    const source =
      typeof body.source === "string" && body.source.trim().length > 0
        ? body.source.trim()
        : "skipped";

    const result = await markOrgOnboardingCompleteService({
      org_id: orgId,
      actor_user_id: actorUserId,
      source,
    });
    return res
      .status(result.statusCode)
      .json({ message: result.message, data: result.data });
  } catch (err) {
    next(err);
  }
};
