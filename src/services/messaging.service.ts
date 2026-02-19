import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import User from "../models/User";
import {
  IStartConversationRequest,
  ISendMessageRequest,
  IConversationQuery,
  IMessageQuery,
} from "../interfaces/messaging.interface";
import { sendNewMessageNotificationMail } from "./nodemailer/mail.service";
import { cloudinaryImageUpload } from "./cloudinary.service";

const DOMAIN_NAME = process.env.DOMAIN_NAME || "http://localhost:3000";

/* ══════════════════════════════════════════════
   Helper: verify user is participant
   ══════════════════════════════════════════════ */

const verifyParticipant = async (conversationId: string, userId: string) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    throw new ApiError(404, "Conversation not found");
  }

  const isParticipant = conversation.participants.some(
    (p) => p.toString() === userId
  );
  if (!isParticipant) {
    throw new ApiError(403, "You are not a participant of this conversation");
  }

  return conversation;
};

/* ══════════════════════════════════════════════
   Service functions
   ══════════════════════════════════════════════ */

/* ── List Conversations ── */

export const listConversationsService = async (
  userId: string,
  query: IConversationQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "20", 10);
  const skip = (page - 1) * limit;

  const filter: any = {
    participants: userId,
  };

  // Filter by archived status
  if (query.archived === "true") {
    filter[`archived.${userId}`] = true;
  } else {
    // Default: exclude archived
    filter.$or = [
      { [`archived.${userId}`]: { $exists: false } },
      { [`archived.${userId}`]: false },
    ];
  }

  // If searching by participant name
  if (query.search && query.search.trim()) {
    const searchRegex = new RegExp(query.search.trim(), "i");
    const matchingUsers = await User.find({
      $or: [{ firstname: searchRegex }, { lastname: searchRegex }],
    }).select("_id");
    const matchingIds = matchingUsers.map((u) => u._id);

    // Conversations where the OTHER participant matches the search
    filter.participants = { $all: [userId], $in: matchingIds };
  }

  const [conversations, total] = await Promise.all([
    Conversation.find(filter)
      .populate(
        "participants",
        "firstname lastname profilePicture role onlineStatus lastSeen"
      )
      .populate("lastMessageSenderId", "firstname lastname")
      .sort({
        [`pinned.${userId}`]: -1,
        lastMessageAt: -1,
        createdAt: -1,
      })
      .skip(skip)
      .limit(limit),
    Conversation.countDocuments(filter),
  ]);

  // Attach unread count per conversation
  const conversationsWithUnread = await Promise.all(
    conversations.map(async (conv) => {
      const unreadCount = await Message.countDocuments({
        conversationId: conv._id,
        senderId: { $ne: userId },
        isRead: false,
      });

      const convObj = conv.toJSON();
      return {
        ...convObj,
        unreadCount,
        isPinned: conv.pinned.get(userId) || false,
        isMuted: conv.muted.get(userId) || false,
        isArchived: conv.archived.get(userId) || false,
      };
    })
  );

  return new ApiResponse(200, "Conversations retrieved successfully", {
    conversations: conversationsWithUnread,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Start / Get Conversation ── */

export const startConversationService = async (
  userId: string,
  data: IStartConversationRequest
) => {
  const { participantId } = data;

  // 1. Cannot message yourself
  if (userId === participantId) {
    throw new ApiError(400, "You cannot start a conversation with yourself");
  }

  // 2. Verify participant exists
  const participant = await User.findById(participantId);
  if (!participant) {
    throw new ApiError(404, "User not found");
  }

  // 3. Check if conversation already exists
  const existing = await Conversation.findOne({
    participants: { $all: [userId, participantId], $size: 2 },
  }).populate(
    "participants",
    "firstname lastname profilePicture role onlineStatus lastSeen"
  );

  if (existing) {
    return new ApiResponse(
      200,
      "Conversation already exists",
      existing.toJSON()
    );
  }

  // 4. Create new conversation (sort IDs for consistent compound index)
  const sortedParticipants = [userId, participantId].sort();
  const conversation = await Conversation.create({
    participants: sortedParticipants,
  });

  // Populate for response
  const populated = await Conversation.findById(conversation._id).populate(
    "participants",
    "firstname lastname profilePicture role onlineStatus lastSeen"
  );

  return new ApiResponse(
    201,
    "Conversation created successfully",
    populated!.toJSON()
  );
};

/* ── List Messages (paginated) ── */

export const listMessagesService = async (
  conversationId: string,
  userId: string,
  query: IMessageQuery
) => {
  await verifyParticipant(conversationId, userId);

  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "30", 10);
  const skip = (page - 1) * limit;

  const filter: any = { conversationId };

  // Optional cursor-based filtering
  if (query.before) {
    filter.createdAt = { $lt: new Date(query.before) };
  }

  const [messages, total] = await Promise.all([
    Message.find(filter)
      .populate("senderId", "firstname lastname profilePicture role")
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit),
    Message.countDocuments(filter),
  ]);

  return new ApiResponse(200, "Messages retrieved successfully", {
    messages: messages.map((m) => m.toJSON()),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Send Text Message ── */

export const sendMessageService = async (
  conversationId: string,
  userId: string,
  userRole: string,
  data: ISendMessageRequest
) => {
  const conversation = await verifyParticipant(conversationId, userId);

  // Create message
  const message = await Message.create({
    conversationId,
    senderId: userId,
    senderType: userRole,
    content: data.content,
    type: data.type || "text",
  });

  // Update conversation with last message info
  const preview =
    data.content.length > 100
      ? data.content.substring(0, 100) + "..."
      : data.content;

  conversation.lastMessage = preview;
  conversation.lastMessageAt = message.createdAt;
  conversation.lastMessageSenderId = userId as any;
  await conversation.save();

  // Populate for response
  const populated = await Message.findById(message._id).populate(
    "senderId",
    "firstname lastname profilePicture role"
  );

  // Send email notification to recipient (non-blocking, respects preferences)
  const recipientId = conversation.participants.find(
    (p) => p.toString() !== userId
  );
  if (recipientId) {
    const isMuted = conversation.muted.get(recipientId.toString()) || false;
    if (!isMuted) {
      _sendMessageNotification(
        userId,
        recipientId.toString(),
        preview,
        conversationId
      ).catch((err) =>
        console.error("Error sending message notification:", err)
      );
    }
  }

  return new ApiResponse(201, "Message sent successfully", populated!.toJSON());
};

/* ── Send File/Image Message ── */

export const sendFileMessageService = async (
  conversationId: string,
  userId: string,
  userRole: string,
  file: Express.Multer.File
) => {
  const conversation = await verifyParticipant(conversationId, userId);

  if (!file) {
    throw new ApiError(400, "No file uploaded");
  }

  // Determine message type based on MIME
  const isImage = file.mimetype.startsWith("image/");
  const messageType = isImage ? "image" : "file";

  // Upload to Cloudinary
  const uploaded = await cloudinaryImageUpload(
    file.buffer,
    `amber/messages/${conversationId}`,
    isImage ? "image" : "raw"
  );

  // Create message
  const message = await Message.create({
    conversationId,
    senderId: userId,
    senderType: userRole,
    content: isImage ? "Sent an image" : `Sent a file: ${file.originalname}`,
    type: messageType,
    fileName: file.originalname,
    fileUrl: uploaded.secure_url,
    fileSize: file.size,
  });

  // Update conversation
  const preview = isImage ? "📷 Image" : `📎 ${file.originalname}`;
  conversation.lastMessage = preview;
  conversation.lastMessageAt = message.createdAt;
  conversation.lastMessageSenderId = userId as any;
  await conversation.save();

  // Populate for response
  const populated = await Message.findById(message._id).populate(
    "senderId",
    "firstname lastname profilePicture role"
  );

  // Notify recipient (non-blocking)
  const recipientId = conversation.participants.find(
    (p) => p.toString() !== userId
  );
  if (recipientId) {
    const isMuted = conversation.muted.get(recipientId.toString()) || false;
    if (!isMuted) {
      _sendMessageNotification(
        userId,
        recipientId.toString(),
        preview,
        conversationId
      ).catch((err) =>
        console.error("Error sending message notification:", err)
      );
    }
  }

  return new ApiResponse(201, "File sent successfully", populated!.toJSON());
};

/* ── Mark All Read ── */

export const markAllReadService = async (
  conversationId: string,
  userId: string
) => {
  await verifyParticipant(conversationId, userId);

  const result = await Message.updateMany(
    {
      conversationId,
      senderId: { $ne: userId },
      isRead: false,
    },
    {
      $set: { isRead: true, readAt: new Date() },
    }
  );

  return new ApiResponse(200, "Messages marked as read", {
    modifiedCount: result.modifiedCount,
  });
};

/* ── Toggle Pin ── */

export const togglePinService = async (
  conversationId: string,
  userId: string
) => {
  const conversation = await verifyParticipant(conversationId, userId);

  const current = conversation.pinned.get(userId) || false;
  conversation.pinned.set(userId, !current);
  await conversation.save();

  return new ApiResponse(
    200,
    !current ? "Conversation pinned" : "Conversation unpinned",
    { isPinned: !current }
  );
};

/* ── Toggle Mute ── */

export const toggleMuteService = async (
  conversationId: string,
  userId: string
) => {
  const conversation = await verifyParticipant(conversationId, userId);

  const current = conversation.muted.get(userId) || false;
  conversation.muted.set(userId, !current);
  await conversation.save();

  return new ApiResponse(
    200,
    !current ? "Conversation muted" : "Conversation unmuted",
    { isMuted: !current }
  );
};

/* ── Toggle Archive ── */

export const toggleArchiveService = async (
  conversationId: string,
  userId: string
) => {
  const conversation = await verifyParticipant(conversationId, userId);

  const current = conversation.archived.get(userId) || false;
  conversation.archived.set(userId, !current);
  await conversation.save();

  return new ApiResponse(
    200,
    !current ? "Conversation archived" : "Conversation unarchived",
    { isArchived: !current }
  );
};

/* ══════════════════════════════════════════════
   Private: send email notification
   (respects notificationPreferences.newMessages)
   ══════════════════════════════════════════════ */

async function _sendMessageNotification(
  senderId: string,
  recipientId: string,
  messagePreview: string,
  conversationId: string
) {
  const [sender, recipient] = await Promise.all([
    User.findById(senderId),
    User.findById(recipientId),
  ]);

  if (!sender || !recipient) return;

  // Check notification preferences
  const prefs = recipient.notificationPreferences;
  if (prefs && prefs.email === false) return;
  if (prefs && prefs.newMessages === false) return;

  sendNewMessageNotificationMail({
    recipientName: recipient.firstname,
    recipientEmail: recipient.email,
    senderName: `${sender.firstname} ${sender.lastname}`,
    messagePreview,
    conversationUrl: `${DOMAIN_NAME}/messages?conversation=${conversationId}`,
  }).catch((err) => console.error("Error sending new message email:", err));
}
