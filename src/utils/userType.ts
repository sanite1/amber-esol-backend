import { IUserDecoded } from "../middlewares/authMiddleWare";

/**
 * True when the user is org-scoped (ESOL learner, org_admin, or any other
 * user provisioned under an organisation). Derived purely from the presence
 * of orgId on the authenticated user, so it works for both the JWT-decoded
 * shape and a freshly-loaded User document with the same field.
 *
 * Returns false for marketplace users (orgId null/undefined) and for
 * unauthenticated requests.
 */
export const isEsolUser = (
  user: Pick<IUserDecoded, "orgId"> | null | undefined
): boolean => {
  return Boolean(user?.orgId);
};
