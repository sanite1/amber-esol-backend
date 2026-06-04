import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { IUserDecoded } from "../middlewares/authMiddleWare";

/**
 * Per-request ESOL context attached by `requireOrgContext` middleware.
 *
 * Every service function that touches learner or session data MUST receive
 * `org_id` as an explicit parameter sourced from this context — never read
 * it from `req.user` directly inside a service. The middleware is the only
 * place where "is this request org-scoped at all?" gets answered.
 *
 * Field naming: snake_case here is deliberate, matching the Project Silk
 * brief. The underlying user record uses camelCase `orgId` — the
 * middleware bridges the two conventions so downstream code can rely on a
 * single consistent shape.
 */
export interface IEsolContext {
  org_id: string;
}

/**
 * Per-request teacher context attached by `requireTeacherContext`
 * middleware — Final Addendum §9. Every service function that
 * touches teacher-scoped data (review writes, assigned-learner
 * reads, prep-list queries) MUST receive `teacher_id` as an
 * explicit parameter sourced from this context, never from
 * `req.user` directly. Same invariant as IEsolContext.
 */
export interface ITeacherContext {
  teacher_id: string;
}

export type ExpressFunction<B = {}, Q = {}> = (
  req: Request<{}, {}, B, Q> & {
    user?: IUserDecoded;
    esol_context?: IEsolContext;
    teacher_context?: ITeacherContext;
  },
  res: Response,
  next: NextFunction
) => void;

export interface IdParam {
  id: Types.ObjectId;
}

export interface PaginationQuery {
  page?: string;
  limit?: string;
  sort?: string;
  search?: string;
}
