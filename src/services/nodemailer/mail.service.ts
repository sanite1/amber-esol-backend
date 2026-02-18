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
