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
    console.error("Error sending welcome email:", error);
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
    console.error("Error sending suspension email:", error);
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
    console.error("Error sending reactivation email:", error);
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
    console.error("Error sending account deleted email:", error);
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
    console.error("Error sending booking request email:", error);
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
    console.error("Error sending booking pending email:", error);
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
    console.error("Error sending booking confirmed email:", error);
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
    console.error("Error sending booking declined email:", error);
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
    console.error("Error sending cancellation email to tutor:", error);
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
    console.error("Error sending cancellation email to student:", error);
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
    console.error("Error sending payment success email:", error);
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
    console.error("Error sending payout requested email:", error);
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
    console.error("Error sending payout completed email:", error);
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
    console.error("Error sending payout rejected email:", error);
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
    console.error("Error sending refund email:", error);
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
    console.error("Error sending new review email:", error);
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
    console.error("Error sending review reply email:", error);
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
    console.error("Error sending review report admin email:", error);
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
    console.error("Error sending review hidden email:", error);
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
    console.error("Error sending review restored email:", error);
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
    console.error("Error sending new message notification email:", error);
  }
};
