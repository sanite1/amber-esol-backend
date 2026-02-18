import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { IUserDecoded } from "../middlewares/authMiddleWare";

export type ExpressFunction<B = {}, Q = {}> = (
  req: Request<{}, {}, B, Q> & { user?: IUserDecoded },
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
