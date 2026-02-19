import { Router } from "express";
import multer from "multer";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import {
  listConversationsValidation,
  startConversationValidation,
  listMessagesValidation,
  sendMessageValidation,
  sendFileMessageValidation,
  conversationIdValidation,
} from "../validations/messaging.validation";
import {
  listConversations,
  startConversation,
  listMessages,
  sendMessage,
  sendFileMessage,
  markAllRead,
  togglePin,
  toggleMute,
  toggleArchive,
} from "../controllers/messaging.controller";

const router = Router();

// Multer (memory storage for Cloudinary upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
  fileFilter: (_req, file, cb) => {
    // Allow images, PDFs, docs, audio
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "audio/mpeg",
      "audio/wav",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("File type not supported"));
    }
  },
});

// ── List user's conversations ──
router.get(
  "/",
  isAuthenticated,
  listConversationsValidation(),
  listConversations
);

// ── Start / get conversation ──
router.post(
  "/",
  isAuthenticated,
  startConversationValidation(),
  startConversation
);

// ── Get messages for a conversation ──
router.get(
  "/:id/messages",
  isAuthenticated,
  listMessagesValidation(),
  listMessages
);

// ── Send text message ──
router.post(
  "/:id/messages",
  isAuthenticated,
  sendMessageValidation(),
  sendMessage
);

// ── Send file/image message ──
router.post(
  "/:id/messages/file",
  isAuthenticated,
  sendFileMessageValidation(),
  upload.single("file"),
  sendFileMessage
);

// ── Mark all messages in conversation as read ──
router.patch(
  "/:id/read",
  isAuthenticated,
  conversationIdValidation(),
  markAllRead
);

// ── Toggle pin ──
router.patch(
  "/:id/pin",
  isAuthenticated,
  conversationIdValidation(),
  togglePin
);

// ── Toggle mute ──
router.patch(
  "/:id/mute",
  isAuthenticated,
  conversationIdValidation(),
  toggleMute
);

// ── Toggle archive ──
router.patch(
  "/:id/archive",
  isAuthenticated,
  conversationIdValidation(),
  toggleArchive
);

export default router;
