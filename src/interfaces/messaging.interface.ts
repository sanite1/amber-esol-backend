import { Types, Document } from "mongoose";

/* ── Enums / Unions ── */

export type MessageType = "text" | "file" | "image";

/* ══════════════════════════════════════════════
   Conversation
   ══════════════════════════════════════════════ */

export interface IConversation extends Document {
  _id: Types.ObjectId;
  participants: Types.ObjectId[]; // exactly 2 user IDs

  lastMessage?: string;
  lastMessageAt?: Date;
  lastMessageSenderId?: Types.ObjectId;

  /* Per-user preferences (keyed by stringified userId) */
  archived: Map<string, boolean>;
  pinned: Map<string, boolean>;
  muted: Map<string, boolean>;

  createdAt: Date;
  updatedAt: Date;
}

/* ══════════════════════════════════════════════
   Message
   ══════════════════════════════════════════════ */

export interface IMessage extends Document {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  senderType: "student" | "tutor" | "admin";

  content: string;
  type: MessageType;

  fileName?: string;
  fileUrl?: string;
  fileSize?: number;

  isRead: boolean;
  readAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

/* ══════════════════════════════════════════════
   Request body interfaces
   ══════════════════════════════════════════════ */

export interface IStartConversationRequest {
  participantId: string;
}

export interface ISendMessageRequest {
  content: string;
  type?: MessageType;
}

/* File message is handled via multipart (multer)
   so no body interface needed — just the req.file */

/* ══════════════════════════════════════════════
   Query interfaces
   ══════════════════════════════════════════════ */

export interface IConversationQuery {
  page?: string;
  limit?: string;
  search?: string;
  archived?: string; // "true" | "false"
}

export interface IMessageQuery {
  page?: string;
  limit?: string;
  before?: string; // ISO date — cursor-based option
}

/* ══════════════════════════════════════════════
   Email contexts
   ══════════════════════════════════════════════ */

export interface NewMessageEmailContext {
  recipientName: string;
  recipientEmail: string;
  senderName: string;
  messagePreview: string;
  conversationUrl: string;
}
