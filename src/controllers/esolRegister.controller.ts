import { ExpressFunction } from "../interfaces/helper.interface";
import {
  esolRegisterService,
  EsolRegisterPayload,
} from "../services/esolRegister.service";

/**
 * POST /api/esol/register — public, no auth required.
 * Brief Function 2 To-Do 2.
 */
export const esolRegister: ExpressFunction<EsolRegisterPayload> = async (
  req,
  res,
  next
) => {
  try {
    const data = await esolRegisterService(req.body as EsolRegisterPayload);
    return res.status(201).json(data);
  } catch (err) {
    next(err);
  }
};
