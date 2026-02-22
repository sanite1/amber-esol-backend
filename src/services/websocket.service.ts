import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { IUserDecoded } from "../middlewares/authMiddleWare";
import Message from "../models/Message";
import Conversation from "../models/Conversation";
import ALLOWED_ORIGINS from "../config/cors";
import logger from "../config/logger";

let io: Server;

/* ── Online users map: userId → Set<socketId> ── */
const onlineUsers = new Map<string, Set<string>>();

/* ══════════════════════════════════════════════
   Initialise Socket.IO
   ══════════════════════════════════════════════ */

export const initSocketIO = (server: HttpServer) => {
  io = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      credentials: true,
    },
    path: "/ws/chat",
  });

  /* ── Authentication middleware ── */
  io.use((socket: Socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(" ")[1];

      if (!token) {
        return next(new Error("Authentication required"));
      }

      const JWT_SECRET = process.env.JWT_SECRET;
      if (!JWT_SECRET) {
        return next(new Error("Server configuration error"));
      }

      const decoded = jwt.verify(token, JWT_SECRET) as IUserDecoded;
      (socket as any).user = decoded;
      next();
    } catch (err) {
      next(new Error("Invalid or expired token"));
    }
  });

  /* ── Connection handler ── */
  io.on("connection", (socket: Socket) => {
    const user = (socket as any).user as IUserDecoded;
    const userId = user.id.toString();

    logger.info({ userId, socketId: socket.id }, "User connected");

    // Track online status
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId)!.add(socket.id);

    // Broadcast online status
    socket.broadcast.emit("user:online", { userId });

    /* ── Join conversation rooms ── */
    socket.on("conversation:join", (conversationId: string) => {
      socket.join(`conversation:${conversationId}`);
      logger.info({ userId, conversationId }, "User joined conversation");
    });

    /* ── Leave conversation room ── */
    socket.on("conversation:leave", (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
    });

    /* ── Typing indicators ── */
    socket.on("typing:start", (data: { conversationId: string }) => {
      socket.to(`conversation:${data.conversationId}`).emit("typing:start", {
        conversationId: data.conversationId,
        userId,
        userName: `${user.firstname} ${user.lastname}`,
      });
    });

    socket.on("typing:stop", (data: { conversationId: string }) => {
      socket.to(`conversation:${data.conversationId}`).emit("typing:stop", {
        conversationId: data.conversationId,
        userId,
      });
    });

    /* ── Message read acknowledgement ── */
    socket.on("message:read", async (data: { conversationId: string }) => {
      try {
        await Message.updateMany(
          {
            conversationId: data.conversationId,
            senderId: { $ne: userId },
            isRead: false,
          },
          { $set: { isRead: true, readAt: new Date() } }
        );

        socket.to(`conversation:${data.conversationId}`).emit("message:read", {
          conversationId: data.conversationId,
          readBy: userId,
          readAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error({ err }, "Error marking messages read");
      }
    });

    /* ── Check online status ── */
    socket.on(
      "user:check-online",
      (data: { userIds: string[] }, callback: Function) => {
        const statuses: Record<string, boolean> = {};
        for (const id of data.userIds) {
          statuses[id] = onlineUsers.has(id) && onlineUsers.get(id)!.size > 0;
        }
        if (typeof callback === "function") {
          callback(statuses);
        }
      }
    );

    /* ── Disconnect ── */
    socket.on("disconnect", () => {
      logger.info({ userId, socketId: socket.id }, "User disconnected");

      const userSockets = onlineUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
          // Broadcast offline status only when all tabs/devices disconnected
          socket.broadcast.emit("user:offline", {
            userId,
            lastSeen: new Date().toISOString(),
          });
        }
      }
    });
  });

  return io;
};

/* ══════════════════════════════════════════════
   Public: get io instance
   ══════════════════════════════════════════════ */

export const getIO = (): Server => {
  if (!io) {
    throw new Error("Socket.IO has not been initialised");
  }
  return io;
};

/* ══════════════════════════════════════════════
   Public: emit new message to a conversation room
   (called from messaging.service.ts after DB write)
   ══════════════════════════════════════════════ */

export const emitNewMessage = (conversationId: string, message: any) => {
  if (!io) return;
  io.to(`conversation:${conversationId}`).emit("message:new", message);
};

/* ── Emit conversation updated (for sidebar) ── */

export const emitConversationUpdated = (
  participantIds: string[],
  conversation: any
) => {
  if (!io) return;
  // Emit to each participant's personal room (they join by their userId)
  for (const pid of participantIds) {
    const sockets = onlineUsers.get(pid);
    if (sockets) {
      for (const socketId of sockets) {
        io.to(socketId).emit("conversation:updated", conversation);
      }
    }
  }
};

/* ── Check if a user is online ── */

export const isUserOnline = (userId: string): boolean => {
  return onlineUsers.has(userId) && onlineUsers.get(userId)!.size > 0;
};
