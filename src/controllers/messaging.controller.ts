import { Request, Response, NextFunction } from "express";
import { ExpressFunction } from "../interfaces/helper.interface";
import {
  IStartConversationRequest,
  ISendMessageRequest,
  IConversationQuery,
  IMessageQuery,
} from "../interfaces/messaging.interface";
import {
  listConversationsService,
  startConversationService,
  listMessagesService,
  sendMessageService,
  sendFileMessageService,
  markAllReadService,
  togglePinService,
  toggleMuteService,
  toggleArchiveService,
} from "../services/messaging.service";
import {
  emitNewMessage,
  emitConversationUpdated,
} from "../services/websocket.service";
import Conversation from "../models/Conversation";

/* ── List Conversations ── */

export const listConversations = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await listConversationsService(
      userId,
      req.query as unknown as IConversationQuery
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Start Conversation ── */

export const startConversation: ExpressFunction<
  IStartConversationRequest
> = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await startConversationService(userId, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── List Messages ── */

export const listMessages = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await listMessagesService(
      req.params.id,
      userId,
      req.query as unknown as IMessageQuery
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Send Text Message ── */

export const sendMessage: ExpressFunction<ISendMessageRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const userRole = (req as any).user?.role;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const data = await sendMessageService(
      req.params.id,
      userId,
      userRole,
      req.body
    );

    // Emit via WebSocket
    emitNewMessage(req.params.id, data.data);

    // Emit conversation updated to both participants
    const conversation = await Conversation.findById(req.params.id)
      .populate(
        "participants",
        "firstname lastname profilePicture role onlineStatus lastSeen"
      )
      .populate("lastMessageSenderId", "firstname lastname");
    if (conversation) {
      const pIds = conversation.participants.map((p: any) =>
        p._id ? p._id.toString() : p.toString()
      );
      emitConversationUpdated(pIds, conversation.toJSON());
    }

    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Send File Message ── */

export const sendFileMessage = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const userRole = (req as any).user?.role;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const data = await sendFileMessageService(
      req.params.id,
      userId,
      userRole,
      file
    );

    // Emit via WebSocket
    emitNewMessage(req.params.id, data.data);

    // Emit conversation updated
    const conversation = await Conversation.findById(req.params.id)
      .populate(
        "participants",
        "firstname lastname profilePicture role onlineStatus lastSeen"
      )
      .populate("lastMessageSenderId", "firstname lastname");
    if (conversation) {
      const pIds = conversation.participants.map((p: any) =>
        p._id ? p._id.toString() : p.toString()
      );
      emitConversationUpdated(pIds, conversation.toJSON());
    }

    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Mark All Read ── */

export const markAllRead = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await markAllReadService(req.params.id, userId);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Toggle Pin ── */

export const togglePin = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await togglePinService(req.params.id, userId);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Toggle Mute ── */

export const toggleMute = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await toggleMuteService(req.params.id, userId);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Toggle Archive ── */

export const toggleArchive = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await toggleArchiveService(req.params.id, userId);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};
