import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  createTicketValidation,
  getMyTicketsValidation,
  replyTicketValidation,
  getAdminTicketsValidation,
  updateTicketStatusValidation,
  updateTicketPriorityValidation,
} from "../validations/ticket.validation";
import {
  createTicket,
  getMyTickets,
  userReplyTicket,
  getAdminTickets,
  adminReplyTicket,
  adminUpdateTicketStatus,
  adminUpdateTicketPriority,
} from "../controllers/ticket.controller";

const router = Router();

// ── User routes (students & tutors) ──
router.post("/", isAuthenticated, createTicketValidation(), createTicket);

router.get("/my", isAuthenticated, getMyTicketsValidation(), getMyTickets);

router.post(
  "/:id/reply",
  isAuthenticated,
  replyTicketValidation(),
  userReplyTicket
);

// ── Admin routes ──
router.get(
  "/admin",
  isAuthenticated,
  isAdmin,
  getAdminTicketsValidation(),
  getAdminTickets
);

router.post(
  "/admin/:id/reply",
  isAuthenticated,
  isAdmin,
  replyTicketValidation(),
  adminReplyTicket
);

router.patch(
  "/admin/:id/status",
  isAuthenticated,
  isAdmin,
  updateTicketStatusValidation(),
  adminUpdateTicketStatus
);

router.patch(
  "/admin/:id/priority",
  isAuthenticated,
  isAdmin,
  updateTicketPriorityValidation(),
  adminUpdateTicketPriority
);

export default router;
