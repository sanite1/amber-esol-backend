import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listSafeguardingMessagesService,
  updateSafeguardingMessageService,
  UpdateSafeguardingMessageBody,
} from "../services/adminSafeguardingMessages.service";

export const listSafeguardingMessages: ExpressFunction = async (
  _req,
  res,
  next,
) => {
  try {
    const result = await listSafeguardingMessagesService();
    return res.status(result.statusCode).json(result);
  } catch (err) {
    next(err);
  }
};

export const updateSafeguardingMessage: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const result = await updateSafeguardingMessageService(
      (req.body ?? {}) as UpdateSafeguardingMessageBody,
      req.user!.id.toString(),
    );
    return res.status(result.statusCode).json(result);
  } catch (err) {
    next(err);
  }
};
