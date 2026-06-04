import ApiError from "../../errors/apiError";
import { IUser } from "../../interfaces/user.interface";
import transporter from "./nodemailer";
import {
  BookingEmailContext,
  PaymentEmailContext,
  SingleBookingEmailContext,
  formatBookingDate,
} from "../../interfaces/booking.interface";
const DOMAIN_NAME = process.env.DOMAIN_NAME;

export const sendVerificationMail = async (userInfo: IUser) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    template: "./verifyemail",
    subject: "Verify Your Email - Amber Training",
    context: {
      name: userInfo.firstname,
      email: userInfo.email,
      url: `${DOMAIN_NAME}/verify/${userInfo._id}/${userInfo.verificationToken}`,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    throw new ApiError(500, `Error sending verification email: ${error}`);
  }
};

export const sendForgotPasswordMail = async (userInfo: IUser) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    subject: "Reset Your Password - Amber Training",
    template: "./passwordreset",
    context: {
      name: userInfo.firstname,
      url: `${DOMAIN_NAME}/reset-password/${userInfo._id}/${userInfo.resetToken}`,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    throw new ApiError(500, `Error sending forgot password mail: ${error}`);
  }
};

export const sendWelcomeMail = async (userInfo: IUser) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    template: "./welcome",
    subject: "Welcome to Amber Training!",
    context: {
      name: userInfo.firstname,
      role: userInfo.role,
      loginUrl: `${DOMAIN_NAME}/login`,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending welcome email");
    // Non-critical, don't throw
  }
};

export const sendAccountSuspendedMail = async (
  userInfo: IUser,
  reason?: string,
  duration?: string
) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    template: "./suspended",
    subject: "Account Suspended - Amber Training",
    context: {
      name: userInfo.firstname,
      reason: reason || "Violation of platform terms",
      duration: duration || "Indefinite",
      supportEmail: process.env.AUTH_EMAIL,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending suspension email");
  }
};

export const sendAccountReactivatedMail = async (userInfo: IUser) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: userInfo.email,
    template: "./reactivated",
    subject: "Account Reactivated - Amber Training",
    context: {
      name: userInfo.firstname,
      loginUrl: `${DOMAIN_NAME}/login`,
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending reactivation email");
  }
};

export const sendAccountDeletedMail = async (user: IUser) => {
  const mailOptions = {
    from: `"Unimerg" <${process.env.AUTH_EMAIL}>`,
    to: user.email,
    subject: "Account Deleted - Unimerg",
    template: "./accountDeleted",
    context: {
      firstname: user.firstname,
      lastname: user.lastname,
      email: user.email,
      deletionDate: new Date().toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      supportEmail: process.env.SUPPORT_EMAIL || "support@ambertraining.co.uk",
      reactivateUrl: `${process.env.DOMAIN_NAME}/help`,
      currentYear: new Date().getFullYear(),
    },
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending account deleted email");
  }
};

/* ── Booking Request (sent to TUTOR) ── */

export const sendBookingRequestMail = async (ctx: BookingEmailContext) => {
  const slotSummary = ctx.bookings
    .map((b) => `${formatBookingDate(b.date)} at ${b.startTime} – ${b.endTime}`)
    .join(", ");

  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.tutor.email,
    template: "./bookingRequest",
    subject: `New Booking Request${ctx.isTrial ? " (Trial)" : ""} - Amber Training`,
    context: {
      tutorName: ctx.tutor.firstname,
      studentName: `${ctx.student.firstname} ${ctx.student.lastname}`,
      isTrial: ctx.isTrial,
      slotCount: ctx.bookings.length,
      slotSummary,
      totalAmount: ctx.totalPrice,
      message: ctx.bookings[0]?.message || "",
      dashboardUrl: `${DOMAIN_NAME}/tutor/lessons`,
      currentYear: new Date().getFullYear(),
    },
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending booking request email");
  }
};

/* ── Booking Pending (sent to STUDENT) ── */

export const sendBookingPendingMail = async (ctx: BookingEmailContext) => {
  const slotSummary = ctx.bookings
    .map((b) => `${formatBookingDate(b.date)} at ${b.startTime} – ${b.endTime}`)
    .join(", ");

  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.student.email,
    template: "./bookingPending",
    subject: `Booking ${ctx.isTrial ? "Trial " : ""}Submitted - Amber Training`,
    context: {
      studentName: ctx.student.firstname,
      tutorName: `${ctx.tutor.firstname} ${ctx.tutor.lastname}`,
      isTrial: ctx.isTrial,
      slotCount: ctx.bookings.length,
      slotSummary,
      totalAmount: ctx.totalPrice,
      lessonsUrl: `${DOMAIN_NAME}/lessons`,
      currentYear: new Date().getFullYear(),
    },
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending booking pending email");
  }
};

/* ── Booking Confirmed (sent to STUDENT) ── */

export const sendBookingConfirmedMail = async (ctx: BookingEmailContext) => {
  const slotSummary = ctx.bookings
    .map((b) => `${formatBookingDate(b.date)} at ${b.startTime} – ${b.endTime}`)
    .join(", ");

  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.student.email,
    template: "./bookingConfirmed",
    subject: `Booking Confirmed! - Amber Training`,
    context: {
      studentName: ctx.student.firstname,
      tutorName: `${ctx.tutor.firstname} ${ctx.tutor.lastname}`,
      isTrial: ctx.isTrial,
      slotCount: ctx.bookings.length,
      slotSummary,
      meetingUrl: ctx.bookings[0]?.meetingUrl || "",
      lessonsUrl: `${DOMAIN_NAME}/lessons`,
      currentYear: new Date().getFullYear(),
    },
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending booking confirmed email");
  }
};

/* ── Booking Declined (sent to STUDENT) ── */

export const sendBookingDeclinedMail = async (
  ctx: SingleBookingEmailContext
) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.student.email,
    template: "./bookingDeclined",
    subject: `Booking Not Accepted - Amber Training`,
    context: {
      studentName: ctx.student.firstname,
      tutorName: `${ctx.tutor.firstname} ${ctx.tutor.lastname}`,
      date: formatBookingDate(ctx.booking.date),
      time: `${ctx.booking.startTime} – ${ctx.booking.endTime}`,
      reason: ctx.reason || "The tutor was unable to accept this booking",
      refunded: ctx.booking.paymentStatus === "refunded",
      findTutorsUrl: `${DOMAIN_NAME}/tutors`,
      currentYear: new Date().getFullYear(),
    },
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending booking declined email");
  }
};

/* ── Booking Cancelled by Student (sent to TUTOR) ── */

export const sendBookingCancelledByStudentMail = async (
  ctx: SingleBookingEmailContext
) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.tutor.email,
    template: "./bookingCancelledByStudent",
    subject: `Booking Cancelled by Student - Amber Training`,
    context: {
      tutorName: ctx.tutor.firstname,
      studentName: `${ctx.student.firstname} ${ctx.student.lastname}`,
      date: formatBookingDate(ctx.booking.date),
      time: `${ctx.booking.startTime} – ${ctx.booking.endTime}`,
      reason: ctx.reason || "No reason provided",
      dashboardUrl: `${DOMAIN_NAME}/tutor/lessons`,
      currentYear: new Date().getFullYear(),
    },
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending cancellation email to tutor");
  }
};

/* ── Booking Cancelled by Tutor (sent to STUDENT) ── */

export const sendBookingCancelledByTutorMail = async (
  ctx: SingleBookingEmailContext
) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.student.email,
    template: "./bookingCancelledByTutor",
    subject: `Booking Cancelled - Amber Training`,
    context: {
      studentName: ctx.student.firstname,
      tutorName: `${ctx.tutor.firstname} ${ctx.tutor.lastname}`,
      date: formatBookingDate(ctx.booking.date),
      time: `${ctx.booking.startTime} – ${ctx.booking.endTime}`,
      reason: ctx.reason || "The tutor was unable to fulfil this booking",
      refunded: ctx.refunded,
      findTutorsUrl: `${DOMAIN_NAME}/tutors`,
      currentYear: new Date().getFullYear(),
    },
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending cancellation email to student");
  }
};

/* ── Payment Success (sent to STUDENT) ── */

export const sendPaymentSuccessMail = async (ctx: PaymentEmailContext) => {
  const slotSummary = ctx.bookings
    .map((b) => `${formatBookingDate(b.date)} at ${b.startTime} – ${b.endTime}`)
    .join(", ");

  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.student.email,
    template: "./paymentSuccess",
    subject: `Payment Confirmed - £${ctx.totalPrice} - Amber Training`,
    context: {
      studentName: ctx.student.firstname,
      tutorName: `${ctx.tutor.firstname} ${ctx.tutor.lastname}`,
      totalAmount: ctx.totalPrice,
      slotCount: ctx.bookings.length,
      slotSummary,
      lessonsUrl: `${DOMAIN_NAME}/lessons`,
      currentYear: new Date().getFullYear(),
    },
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending payment success email");
  }
};

import {
  PayoutEmailContext,
  RefundEmailContext,
} from "../../interfaces/payment.interface";
import {
  ReviewEmailContext,
  ReviewReplyEmailContext,
  ReviewReportEmailContext,
} from "../../interfaces/review.interface";
import { NewMessageEmailContext } from "../../interfaces/messaging.interface";
import logger from "../../config/logger";

/* ── Payout Requested (sent to TUTOR) ── */

export const sendPayoutRequestedMail = async (ctx: PayoutEmailContext) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.tutorEmail,
    template: "./payoutRequested",
    subject: `Payout Request Submitted - £${ctx.amount} - Amber Training`,
    context: {
      tutorName: ctx.tutorName,
      amount: ctx.amount,
      currency: ctx.currency,
      status: ctx.status,
      dashboardUrl: `${DOMAIN_NAME}/tutor/payments`,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending payout requested email");
  }
};

/* ── Payout Completed (sent to TUTOR) ── */

export const sendPayoutCompletedMail = async (ctx: PayoutEmailContext) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.tutorEmail,
    template: "./payoutCompleted",
    subject: `Payout Completed - £${ctx.amount} - Amber Training`,
    context: {
      tutorName: ctx.tutorName,
      amount: ctx.amount,
      currency: ctx.currency,
      reference: ctx.reference || "N/A",
      dashboardUrl: `${DOMAIN_NAME}/tutor/payments`,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending payout completed email");
  }
};

/* ── Payout Rejected (sent to TUTOR) ── */

export const sendPayoutRejectedMail = async (ctx: PayoutEmailContext) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.tutorEmail,
    template: "./payoutRejected",
    subject: `Payout Request Update - Amber Training`,
    context: {
      tutorName: ctx.tutorName,
      amount: ctx.amount,
      currency: ctx.currency,
      reason: ctx.reason || "No reason provided",
      supportEmail: process.env.AUTH_EMAIL,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending payout rejected email");
  }
};

/* ── Refund Issued (sent to STUDENT) ── */

export const sendRefundIssuedMail = async (ctx: RefundEmailContext) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.studentEmail,
    template: "./refundIssued",
    subject: `Refund Processed - £${ctx.amount} - Amber Training`,
    context: {
      studentName: ctx.studentName,
      tutorName: ctx.tutorName,
      amount: ctx.amount,
      currency: ctx.currency,
      reason: ctx.reason || "Refund processed",
      bookingDate: ctx.bookingDate,
      lessonsUrl: `${DOMAIN_NAME}/lessons`,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending refund email");
  }
};

/* ── New Review (sent to TUTOR) ── */

export const sendNewReviewMail = async (ctx: ReviewEmailContext) => {
  const stars = "★".repeat(ctx.rating) + "☆".repeat(5 - ctx.rating);
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.tutorEmail,
    template: "./newReview",
    subject: `New ${ctx.rating}-Star Review - Amber Training`,
    context: {
      tutorName: ctx.tutorName,
      studentName: ctx.studentName,
      rating: ctx.rating,
      stars,
      comment: ctx.comment,
      lessonTopic: ctx.lessonTopic || "General",
      reviewUrl: ctx.reviewUrl,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending new review email");
  }
};

/* ── Review Reply (sent to STUDENT) ── */

export const sendReviewReplyMail = async (ctx: ReviewReplyEmailContext) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.studentEmail,
    template: "./reviewReply",
    subject: `Your Tutor Replied to Your Review - Amber Training`,
    context: {
      studentName: ctx.studentName,
      tutorName: ctx.tutorName,
      replyText: ctx.replyText,
      reviewUrl: ctx.reviewUrl,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending review reply email");
  }
};

/* ── Review Report (sent to ADMIN) ── */

export const sendReviewReportAdminMail = async (
  ctx: ReviewReportEmailContext
) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: process.env.ADMIN_EMAIL || process.env.AUTH_EMAIL,
    template: "./reviewReportAdmin",
    subject: `Review Reported - Action Required - Amber Training`,
    context: {
      reviewId: ctx.reviewId,
      reporterName: ctx.reporterName,
      reason: ctx.reason,
      adminUrl: ctx.adminUrl,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending review report admin email");
  }
};

/* ── Review Hidden (sent to STUDENT) ── */

export const sendReviewHiddenMail = async (ctx: ReviewEmailContext) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.studentEmail,
    template: "./reviewHidden",
    subject: `Review Update - Amber Training`,
    context: {
      studentName: ctx.studentName,
      rating: ctx.rating,
      comment:
        ctx.comment.length > 100
          ? ctx.comment.substring(0, 100) + "..."
          : ctx.comment,
      supportEmail: process.env.AUTH_EMAIL,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending review hidden email");
  }
};

/* ── Review Restored (sent to STUDENT) ── */

export const sendReviewRestoredMail = async (ctx: ReviewEmailContext) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.studentEmail,
    template: "./reviewRestored",
    subject: `Review Restored - Amber Training`,
    context: {
      studentName: ctx.studentName,
      reviewUrl: ctx.reviewUrl,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending review restored email");
  }
};

/* ── New Message Notification (sent to RECIPIENT) ── */

export const sendNewMessageNotificationMail = async (
  ctx: NewMessageEmailContext
) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.recipientEmail,
    template: "./newMessage",
    subject: `New Message from ${ctx.senderName} - Amber Training`,
    context: {
      recipientName: ctx.recipientName,
      senderName: ctx.senderName,
      messagePreview: ctx.messagePreview,
      conversationUrl: ctx.conversationUrl,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error(
      { err: error },
      "Error sending new message notification email"
    );
  }
};

/* ── Safeguarding Alert (sent to safeguarding officer) ── */

export const sendSafeguardingAlertMail = async (ctx: {
  alertLevel: "low" | "medium" | "high" | "critical";
  learnerName: string;
  orgName: string;
  sessionId: string;
  reasoning: string;
  raisedAt: Date;
}) => {
  const recipient = process.env.SAFEGUARDING_ALERT_EMAIL;
  if (!recipient) {
    logger.error("SAFEGUARDING_ALERT_EMAIL is not configured — alert not sent");
    return;
  }

  const formattedDate = ctx.raisedAt.toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });

  const mailOptions = {
    from: `"Amber Training Safeguarding" <${process.env.AUTH_EMAIL}>`,
    to: recipient,
    template: "./safeguardingAlert",
    subject: `[${ctx.alertLevel.toUpperCase()}] Safeguarding Alert — Amber Training`,
    context: {
      alertLevel: ctx.alertLevel,
      learnerName: ctx.learnerName,
      orgName: ctx.orgName,
      sessionId: ctx.sessionId,
      reasoning: ctx.reasoning,
      raisedAt: formattedDate,
      dashboardUrl: `${DOMAIN_NAME}/admin/safeguarding/${ctx.sessionId}`,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending safeguarding alert email");
  }
};

/* ── Learner Invite (sent to prospective ESOL learner) ── */

export const sendLearnerInviteMail = async (ctx: {
  toEmail: string;
  learnerName?: string;
  orgName: string;
  esolLevel: string;
  inviteUrl: string;
  expiryDate: string;
}) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.toEmail,
    template: "./learnerInvite",
    subject: `You've Been Invited to Join ${ctx.orgName} — Amber Training`,
    context: {
      learnerName: ctx.learnerName || "",
      orgName: ctx.orgName,
      esolLevel: ctx.esolLevel,
      inviteUrl: ctx.inviteUrl,
      expiryDate: ctx.expiryDate,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending learner invite email");
  }
};

/* ── Lesson Completed + Review Prompt (sent to STUDENT) ── */

export const sendLessonCompletedMail = async (ctx: {
  studentName: string;
  studentEmail: string;
  tutorName: string;
  lessonDate: string;
  lessonTime: string;
  lessonType: string;
  reviewUrl: string;
}) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.studentEmail,
    template: "./lessonCompleted",
    subject: `Lesson Completed — How was your session? - Amber Training`,
    context: {
      studentName: ctx.studentName,
      tutorName: ctx.tutorName,
      lessonDate: ctx.lessonDate,
      lessonTime: ctx.lessonTime,
      lessonType: ctx.lessonType,
      reviewUrl: ctx.reviewUrl,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending lesson completed email");
  }
};

/* ── ESOL Teacher Approval (brief §2 Change 2) ── */

export const sendEsolTeacherApprovalMail = async (ctx: {
  toEmail: string;
  teacherName: string;
  qualificationType: string;
  dashboardUrl: string;
  notes?: string | null;
}) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.toEmail,
    template: "./esolTeacherApproved",
    subject: "You're approved to teach ESOL — Amber Training",
    context: {
      teacherName: ctx.teacherName,
      qualificationType: ctx.qualificationType,
      dashboardUrl: ctx.dashboardUrl,
      notes: ctx.notes || "",
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending ESOL approval email");
  }
};

/* ── ESOL Teacher Rejection (brief §2 Change 2) ── */

export const sendEsolTeacherRejectionMail = async (ctx: {
  toEmail: string;
  teacherName: string;
  reason: string;
}) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.toEmail,
    template: "./esolTeacherRejected",
    subject: "Update on your ESOL teaching application — Amber Training",
    context: {
      teacherName: ctx.teacherName,
      reason: ctx.reason,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending ESOL rejection email");
  }
};

/* ── Org admin welcome (brief Function 1) ── */

export const sendOrgAdminWelcomeMail = async (ctx: {
  toEmail: string;
  firstname: string;
  orgName: string;
  loginUrl: string;
  /**
   * Final Addendum §13 — optional prefill URL for the ROI
   * calculator section in the welcome email. When omitted (or
   * empty) the template's `{{#if roiCalculatorUrl}}` block hides
   * the entire CTA section, so org creations without sales
   * context don't show a half-empty calculator pitch.
   */
  roiCalculatorUrl?: string | null;
}) => {
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: ctx.toEmail,
    template: "./orgAdminWelcome",
    subject: `Welcome to Amber Training — Your ${ctx.orgName} admin account is ready`,
    context: {
      firstname: ctx.firstname,
      email: ctx.toEmail,
      orgName: ctx.orgName,
      loginUrl: ctx.loginUrl,
      roiCalculatorUrl: ctx.roiCalculatorUrl ?? null,
      currentYear: new Date().getFullYear(),
    },
  };
  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error({ err: error }, "Error sending org admin welcome email");
  }
};
