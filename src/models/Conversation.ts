import { Schema, model } from "mongoose";
import { IConversation } from "../interfaces/messaging.interface";

const conversationSchema = new Schema<IConversation>(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      validate: {
        validator: (val: any[]) => val.length === 2,
        message: "A conversation must have exactly 2 participants",
      },
      required: true,
    },

    lastMessage: { type: String, default: undefined },
    lastMessageAt: { type: Date, default: undefined },
    lastMessageSenderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: undefined,
    },

    archived: {
      type: Map,
      of: Boolean,
      default: {},
    },
    pinned: {
      type: Map,
      of: Boolean,
      default: {},
    },
    muted: {
      type: Map,
      of: Boolean,
      default: {},
    },
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

// Compound unique index: prevent duplicate conversations between the same two users
conversationSchema.index(
  { participants: 1 },
  {
    unique: true,
  },
);

// Index for listing user conversations sorted by latest message
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

const Conversation = model<IConversation>("Conversation", conversationSchema);

export default Conversation;
