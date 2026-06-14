import { Schema, model } from "mongoose";
import { IMessage } from "../interfaces/messaging.interface";

const messageSchema = new Schema<IMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    senderType: {
      type: String,
      enum: ["student", "tutor", "admin"],
      required: true,
    },

    content: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["text", "file", "image"],
      default: "text",
    },

    fileName: { type: String, trim: true },
    fileUrl: { type: String, trim: true },
    fileSize: { type: Number },

    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  },
);

// Index for fetching messages in a conversation (paginated, descending)
messageSchema.index({ conversationId: 1, createdAt: -1 });

// Index for unread count queries
messageSchema.index({ conversationId: 1, senderId: 1, isRead: 1 });

const Message = model<IMessage>("Message", messageSchema);

export default Message;
