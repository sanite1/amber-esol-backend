import { randomUUID } from "crypto";
import Stripe from "stripe";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Booking from "../models/Booking";
import User from "../models/User";
import Availability from "../models/Availability";
import DateOverride from "../models/DateOverride";
import {
  ICreateBookingRequest,
  ICancelBookingRequest,
  IDeclineBookingRequest,
  IBookingQuery,
  IUpcomingQuery,
  BookingStatus,
} from "../interfaces/booking.interface";
import {
  sendBookingRequestMail,
  sendBookingPendingMail,
  sendBookingConfirmedMail,
  sendBookingDeclinedMail,
  sendBookingCancelledByStudentMail,
  sendBookingCancelledByTutorMail,
} from "./nodemailer/mail.service";
import { creditTutorForCompletedLesson } from "./payment.service";
import { createNotification } from "./notification.service";
import Transaction from "../models/Transaction";
import Wallet from "../models/Wallet";
import { createDailyRoom } from "./daily.service";
import { createZoomMeeting } from "./zoom.service";

/* ── Stripe init ── */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

const DOMAIN_NAME = process.env.DOMAIN_NAME || "http://localhost:3000";

/* ── Helper: convert "HH:mm" to minutes since midnight ── */

const timeToMinutes = (time: string): number => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/* ══════════════════════════════════════════════
   Service functions
   ══════════════════════════════════════════════ */

/* ── Create Booking ── */

export const createBookingService = async (
  studentId: string,
  data: ICreateBookingRequest
) => {
  // 1. Validate student exists
  const student = await User.findById(studentId);
  if (!student || student.role !== "student") {
    throw new ApiError(404, "Student not found");
  }

  // 2. Validate tutor exists
  const tutor = await User.findById(data.tutorId);
  if (!tutor || tutor.role !== "tutor") {
    throw new ApiError(404, "Tutor not found");
  }

  if (!tutor.isActive) {
    throw new ApiError(400, "This tutor is currently unavailable");
  }

  // 3. Trial-specific checks
  if (data.type === "trial") {
    if (!tutor.trialLessonOffered) {
      throw new ApiError(400, "This tutor does not offer trial lessons");
    }

    const existingTrial = await Booking.findOne({
      studentId,
      tutorId: data.tutorId,
      type: "trial",
      status: {
        $nin: ["cancelled_student", "cancelled_tutor", "cancelled_admin"],
      },
    });
    if (existingTrial) {
      throw new ApiError(
        400,
        "You have already booked a trial lesson with this tutor"
      );
    }
  }

  // 4. Get tutor availability config
  const availability = await Availability.findOne({ tutorId: data.tutorId });
  if (!availability) {
    throw new ApiError(400, "This tutor has not configured their availability");
  }

  // 5. Validate each slot is available
  for (const slot of data.slots) {
    const slotDate = slot.date;

    const today = new Date().toISOString().split("T")[0];
    if (slotDate < today) {
      throw new ApiError(400, `Cannot book a slot in the past (${slotDate})`);
    }

    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + availability.maxBookingAdvance);
    const reqDate = new Date(slotDate + "T00:00:00Z");
    if (reqDate > maxDate) {
      throw new ApiError(
        400,
        `Date ${slotDate} is beyond the maximum booking advance of ${availability.maxBookingAdvance} days`
      );
    }

    const conflict = await Booking.findOne({
      tutorId: data.tutorId,
      date: slotDate,
      startTime: slot.startTime,
      status: { $in: ["pending", "confirmed"] },
    });
    if (conflict) {
      throw new ApiError(
        400,
        `Slot ${slot.startTime} on ${slotDate} is already booked`
      );
    }

    const override = await DateOverride.findOne({
      tutorId: data.tutorId,
      date: slotDate,
      type: "unavailable",
    });
    if (override) {
      throw new ApiError(
        400,
        `Tutor is unavailable on ${slotDate}${override.reason ? `: ${override.reason}` : ""}`
      );
    }
  }

  // 6. Calculate pricing
  const isTrial = data.type === "trial";
  const pricePerSlot = isTrial
    ? tutor.trialLessonPrice || 0
    : tutor.hourlyRate || 0;
  const totalPrice = pricePerSlot * data.slots.length;
  const isFree = totalPrice === 0;

  // 7. Determine auto-confirm
  const autoConfirm = tutor.teachingPreferences?.autoAcceptBookings === true;

  // 8. Create booking documents
  const bookingGroupId = data.slots.length > 1 ? randomUUID() : undefined;

  const bookingDocs = data.slots.map((slot) => ({
    studentId,
    tutorId: data.tutorId,
    type: data.type,
    status: isFree && autoConfirm ? "confirmed" : "pending",
    bookingGroupId,
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    timezone: availability.timezone,
    price: pricePerSlot,
    currency: "GBP",
    specialty: data.specialty,
    notes: data.notes,
    message: data.message,
    paymentStatus: isFree ? "free" : "pending",
  }));

  const bookings = await Booking.insertMany(bookingDocs);

  // 9. Handle payment
  let checkoutUrl: string | null = null;

  if (!isFree) {
    const lineItems = [
      {
        price_data: {
          currency: "gbp",
          product_data: {
            name: `${data.type === "trial" ? "Trial" : ""} Lesson with ${tutor.firstname} ${tutor.lastname}`.trim(),
            description: `${data.slots.length} × ${data.type === "trial" ? "30" : "60"}-minute session${data.slots.length > 1 ? "s" : ""}`,
          },
          unit_amount: Math.round(pricePerSlot * 100),
        },
        quantity: data.slots.length,
      },
    ];

    const sessionMetadata: Record<string, string> = {
      studentId,
      tutorId: data.tutorId,
      bookingType: data.type,
      bookingIds: bookings.map((b) => b._id.toString()).join(","),
    };
    if (bookingGroupId) {
      sessionMetadata.bookingGroupId = bookingGroupId;
    }

    const successUrl = data.successUrl || `${DOMAIN_NAME}/lessons`;
    const cancelUrl = data.cancelUrl || `${DOMAIN_NAME}/tutors/${data.tutorId}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      metadata: sessionMetadata,
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    await Booking.updateMany(
      { _id: { $in: bookings.map((b) => b._id) } },
      { $set: { stripeCheckoutSessionId: session.id } }
    );

    checkoutUrl = session.url;
  }

  // 10. Send notifications
  const firstSlot = data.slots[0];
  const slotSummary =
    data.slots.length > 1
      ? `${data.slots.length} sessions starting ${firstSlot.date}`
      : `${firstSlot.date} at ${firstSlot.startTime}`;

  createNotification({
    userId: tutor._id,
    type: "booking_created",
    title: "New Booking Request",
    message: `${student.firstname} ${student.lastname} has requested a ${data.type} lesson on ${slotSummary}.`,
    data: {
      bookingIds: bookings.map((b) => b._id.toString()),
      bookingGroupId: bookingGroupId || null,
      studentId,
      date: firstSlot.date,
      startTime: firstSlot.startTime,
      endTime: firstSlot.endTime,
      type: data.type,
      totalSlots: data.slots.length,
    },
  }).catch((err) => console.error("Error creating booking notification:", err));

  if (isFree && autoConfirm) {
    createNotification({
      userId: studentId,
      type: "booking_confirmed",
      title: "Booking Confirmed",
      message: `Your ${data.type} lesson with ${tutor.firstname} ${tutor.lastname} on ${slotSummary} has been automatically confirmed.`,
      data: {
        bookingIds: bookings.map((b) => b._id.toString()),
        bookingGroupId: bookingGroupId || null,
        tutorId: data.tutorId,
        date: firstSlot.date,
        startTime: firstSlot.startTime,
      },
    }).catch((err) =>
      console.error("Error creating confirmed notification:", err)
    );
  }

  return new ApiResponse(201, "Booking created successfully", {
    bookings: bookings.map((b) => b.toJSON()),
    bookingGroupId: bookingGroupId || null,
    checkoutUrl,
    totalPrice,
    paymentRequired: !isFree,
  });
};

// ── REMOVED: handleStripeWebhookService — moved to webhook.service.ts ──

/* ── List Bookings (role-aware) ── */

export const listBookingsService = async (
  userId: string,
  role: string,
  query: IBookingQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  const filter: any = {};

  if (role === "student") {
    filter.studentId = userId;
  } else if (role === "tutor") {
    filter.tutorId = userId;
  }

  if (query.status) {
    filter.status = query.status;
  }

  if (query.type) {
    filter.type = query.type;
  }

  if (query.dateFrom || query.dateTo) {
    filter.date = {};
    if (query.dateFrom) filter.date.$gte = query.dateFrom;
    if (query.dateTo) filter.date.$lte = query.dateTo;
  }

  if (query.search) {
    const searchRegex = new RegExp(query.search, "i");

    const matchingUsers = await User.find({
      $or: [{ firstname: searchRegex }, { lastname: searchRegex }],
    }).select("_id");

    const matchingIds = matchingUsers.map((u) => u._id);

    if (role === "student") {
      filter.tutorId = { $in: matchingIds };
    } else if (role === "tutor") {
      filter.studentId = { $in: matchingIds };
    } else {
      filter.$or = [
        { studentId: { $in: matchingIds } },
        { tutorId: { $in: matchingIds } },
      ];
    }
  }

  let sortOption: any = { createdAt: -1 };
  switch (query.sort) {
    case "newest":
      sortOption = { createdAt: -1 };
      break;
    case "oldest":
      sortOption = { createdAt: 1 };
      break;
    case "price_high":
      sortOption = { price: -1 };
      break;
    case "price_low":
      sortOption = { price: 1 };
      break;
  }

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .populate(
        "studentId",
        "firstname lastname profilePicture learningPreferences address"
      )
      .populate(
        "tutorId",
        "firstname lastname profilePicture specializations hourlyRate"
      )
      .sort(sortOption)
      .skip(skip)
      .limit(limit),
    Booking.countDocuments(filter),
  ]);

  return new ApiResponse(200, "Bookings retrieved successfully", {
    bookings: bookings.map((b) => b.toJSON()),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Get Booking By Id ── */

export const getBookingByIdService = async (
  bookingId: string,
  userId: string,
  role: string
) => {
  const booking = await Booking.findById(bookingId)
    .populate(
      "studentId",
      "firstname lastname profilePicture email learningPreferences address"
    )
    .populate(
      "tutorId",
      "firstname lastname profilePicture email specializations hourlyRate"
    );

  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  const isStudent = booking.studentId._id.toString() === userId;
  const isTutor = booking.tutorId._id.toString() === userId;
  const isAdmin = role === "admin";

  if (!isStudent && !isTutor && !isAdmin) {
    throw new ApiError(403, "You are not authorized to view this booking");
  }

  return new ApiResponse(
    200,
    "Booking retrieved successfully",
    booking.toJSON()
  );
};

/* ── Confirm Booking (tutor) ── */

export const confirmBookingService = async (
  bookingId: string,
  tutorId: string
) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  if (booking.tutorId.toString() !== tutorId) {
    throw new ApiError(403, "You are not authorized to confirm this booking");
  }

  if (booking.status !== "pending") {
    throw new ApiError(
      400,
      `Cannot confirm a booking with status "${booking.status}"`
    );
  }

  if (booking.paymentStatus !== "paid" && booking.paymentStatus !== "free") {
    throw new ApiError(
      400,
      "Cannot confirm booking — payment has not been received"
    );
  }

  booking.status = "confirmed";

  // ── Auto-generate a Zoom meeting link if no URL exists yet ──
  if (!booking.meetingUrl) {
    const student = await User.findById(booking.studentId).select(
      "firstname lastname"
    );
    const tutor = await User.findById(booking.tutorId).select(
      "firstname lastname"
    );

    const zoomUrl = await createZoomMeeting(
      booking._id.toString(),
      booking.date,
      booking.startTime,
      booking.endTime,
      `${tutor?.firstname || "Tutor"} ${tutor?.lastname || ""}`.trim(),
      `${student?.firstname || "Student"} ${student?.lastname || ""}`.trim(),
      booking.type,
      booking.specialty
    );

    if (zoomUrl) {
      booking.meetingUrl = zoomUrl;
    }
  }

  await booking.save();

  const student = await User.findById(booking.studentId);
  const tutor = await User.findById(booking.tutorId);

  if (student && tutor) {
    sendBookingConfirmedMail({
      student,
      tutor,
      bookings: [booking],
      totalPrice: booking.price,
      isTrial: booking.type === "trial",
      bookingGroupId: booking.bookingGroupId,
    }).catch((err) => console.error("Error sending confirmed email:", err));
  }

  await User.findByIdAndUpdate(tutorId, {
    $inc: { totalStudents: 1 },
  });

  createNotification({
    userId: booking.studentId,
    type: "booking_confirmed",
    title: "Booking Confirmed",
    message: `Your ${booking.type} lesson on ${booking.date} at ${booking.startTime} with ${tutor?.firstname || "your tutor"} ${tutor?.lastname || ""} has been confirmed.`,
    data: {
      bookingId: booking._id.toString(),
      tutorId: booking.tutorId.toString(),
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      type: booking.type,
      meetingUrl: booking.meetingUrl || null,
    },
  }).catch((err) =>
    console.error("Error creating confirmed notification:", err)
  );

  return new ApiResponse(
    200,
    "Booking confirmed successfully",
    booking.toJSON()
  );
};

/* ── Decline Booking (tutor) ── */

export const declineBookingService = async (
  bookingId: string,
  tutorId: string,
  data: IDeclineBookingRequest
) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  if (booking.tutorId.toString() !== tutorId) {
    throw new ApiError(403, "You are not authorized to decline this booking");
  }

  if (booking.status !== "pending") {
    throw new ApiError(
      400,
      `Cannot decline a booking with status "${booking.status}"`
    );
  }

  booking.status = "cancelled_tutor";
  booking.cancelReason = data.reason || "Declined by tutor";
  booking.cancelledBy = "tutor";
  booking.cancelledAt = new Date();
  await booking.save();

  if (booking.paymentStatus === "paid" && booking.stripePaymentIntentId) {
    try {
      await stripe.refunds.create({
        payment_intent: booking.stripePaymentIntentId,
      });
      booking.paymentStatus = "refunded";
      await booking.save();
    } catch (err) {
      console.error("Stripe refund error:", err);
    }
  }

  const student = await User.findById(booking.studentId);
  const tutor = await User.findById(booking.tutorId);

  if (student && tutor) {
    sendBookingDeclinedMail({
      student,
      tutor,
      booking,
      reason: data.reason,
    }).catch((err) => console.error("Error sending declined email:", err));
  }

  createNotification({
    userId: booking.studentId,
    type: "booking_declined",
    title: "Booking Declined",
    message: `Your booking request for ${booking.date} at ${booking.startTime} with ${tutor?.firstname || "your tutor"} ${tutor?.lastname || ""} has been declined.${data.reason ? ` Reason: ${data.reason}` : ""}`,
    data: {
      bookingId: booking._id.toString(),
      tutorId: booking.tutorId.toString(),
      date: booking.date,
      startTime: booking.startTime,
      reason: data.reason || null,
      refunded: booking.paymentStatus === "refunded",
    },
  }).catch((err) =>
    console.error("Error creating declined notification:", err)
  );

  if (booking.paymentStatus === "refunded") {
    createNotification({
      userId: booking.studentId,
      type: "refund_processed",
      title: "Refund Processed",
      message: `A refund of £${booking.price.toFixed(2)} has been issued for your declined booking on ${booking.date}.`,
      data: {
        bookingId: booking._id.toString(),
        amount: booking.price,
        date: booking.date,
      },
    }).catch((err) =>
      console.error("Error creating refund notification:", err)
    );
  }

  return new ApiResponse(
    200,
    "Booking declined successfully",
    booking.toJSON()
  );
};

/* ── Cancel Booking (student or tutor) ── */

export const cancelBookingService = async (
  bookingId: string,
  userId: string,
  role: string,
  data: ICancelBookingRequest
) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  const isBookingStudent = booking.studentId.toString() === userId;
  const isBookingTutor = booking.tutorId.toString() === userId;
  const isAdmin = role === "admin";

  if (!isBookingStudent && !isBookingTutor && !isAdmin) {
    throw new ApiError(403, "You are not authorized to cancel this booking");
  }

  if (
    booking.status === "completed" ||
    booking.status === "no_show" ||
    booking.status.startsWith("cancelled")
  ) {
    throw new ApiError(
      400,
      `Cannot cancel a booking with status "${booking.status}"`
    );
  }

  let cancelledBy: "student" | "tutor" | "admin";
  let newStatus: BookingStatus;

  if (isAdmin) {
    cancelledBy = "admin";
    newStatus = "cancelled_admin";
  } else if (isBookingStudent) {
    cancelledBy = "student";
    newStatus = "cancelled_student";
  } else {
    cancelledBy = "tutor";
    newStatus = "cancelled_tutor";
  }

  booking.status = newStatus;
  booking.cancelReason = data.reason || `Cancelled by ${cancelledBy}`;
  booking.cancelledBy = cancelledBy;
  booking.cancelledAt = new Date();
  await booking.save();

  if (booking.paymentStatus === "paid" && booking.stripePaymentIntentId) {
    const lessonDateTime = new Date(`${booking.date}T${booking.startTime}:00Z`);
    const hoursUntilLesson =
      (lessonDateTime.getTime() - Date.now()) / (1000 * 60 * 60);

    if (
      hoursUntilLesson >= 24 ||
      cancelledBy === "tutor" ||
      cancelledBy === "admin"
    ) {
      try {
        await stripe.refunds.create({
          payment_intent: booking.stripePaymentIntentId,
        });
        booking.paymentStatus = "refunded";
        await booking.save();
      } catch (err) {
        console.error("Stripe refund error:", err);
      }
    }
  }

  const student = await User.findById(booking.studentId);
  const tutor = await User.findById(booking.tutorId);

  if (student && tutor) {
    if (cancelledBy === "student") {
      sendBookingCancelledByStudentMail({
        student,
        tutor,
        booking,
        reason: data.reason,
      }).catch((err) =>
        console.error("Error sending cancellation email to tutor:", err)
      );
    } else {
      sendBookingCancelledByTutorMail({
        student,
        tutor,
        booking,
        reason: data.reason,
        refunded: booking.paymentStatus === "refunded",
      }).catch((err) =>
        console.error("Error sending cancellation email to student:", err)
      );
    }
  }

  const recipientId =
    cancelledBy === "student" ? booking.tutorId : booking.studentId;
  const cancellerName =
    cancelledBy === "student"
      ? `${student?.firstname || "Student"} ${student?.lastname || ""}`
      : cancelledBy === "tutor"
        ? `${tutor?.firstname || "Tutor"} ${tutor?.lastname || ""}`
        : "An administrator";

  createNotification({
    userId: recipientId,
    type: "booking_cancelled",
    title: "Booking Cancelled",
    message: `${cancellerName} has cancelled the ${booking.type} lesson on ${booking.date} at ${booking.startTime}.${data.reason ? ` Reason: ${data.reason}` : ""}`,
    data: {
      bookingId: booking._id.toString(),
      cancelledBy,
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      reason: data.reason || null,
      refunded: booking.paymentStatus === "refunded",
    },
  }).catch((err) =>
    console.error("Error creating cancellation notification:", err)
  );

  if (booking.paymentStatus === "refunded" && cancelledBy !== "student") {
    createNotification({
      userId: booking.studentId,
      type: "refund_processed",
      title: "Refund Processed",
      message: `A refund of £${booking.price.toFixed(2)} has been issued for the cancelled lesson on ${booking.date}.`,
      data: {
        bookingId: booking._id.toString(),
        amount: booking.price,
        date: booking.date,
      },
    }).catch((err) =>
      console.error("Error creating refund notification:", err)
    );
  }

  return new ApiResponse(
    200,
    "Booking cancelled successfully",
    booking.toJSON()
  );
};

/* ── Complete Booking ── */

export const completeBookingService = async (
  bookingId: string,
  userId: string,
  role: string
) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  const isBookingTutor = booking.tutorId.toString() === userId;
  const isAdmin = role === "admin";

  if (!isBookingTutor && !isAdmin) {
    throw new ApiError(403, "You are not authorized to complete this booking");
  }

  if (booking.status !== "confirmed") {
    throw new ApiError(
      400,
      `Cannot complete a booking with status "${booking.status}"`
    );
  }

  booking.status = "completed";
  booking.completedAt = new Date();
  await booking.save();
  await creditTutorForCompletedLesson(bookingId);

  await User.findByIdAndUpdate(booking.tutorId, {
    $inc: { totalLessons: 1 },
  });

  await User.findByIdAndUpdate(booking.studentId, {
    $inc: { totalLessonsTaken: 1, totalHoursLearned: 1 },
  });

  const student = await User.findById(booking.studentId).select(
    "firstname lastname"
  );
  const tutor = await User.findById(booking.tutorId).select(
    "firstname lastname"
  );

  createNotification({
    userId: booking.studentId,
    type: "booking_completed",
    title: "Lesson Completed",
    message: `Your ${booking.type} lesson on ${booking.date} with ${tutor?.firstname || "your tutor"} ${tutor?.lastname || ""} has been marked as completed.`,
    data: {
      bookingId: booking._id.toString(),
      tutorId: booking.tutorId.toString(),
      date: booking.date,
      startTime: booking.startTime,
    },
  }).catch((err) =>
    console.error("Error creating student completion notification:", err)
  );

  createNotification({
    userId: booking.tutorId,
    type: "booking_completed",
    title: "Lesson Completed",
    message: `Your ${booking.type} lesson on ${booking.date} with ${student?.firstname || "your student"} ${student?.lastname || ""} has been completed. Earnings have been credited.`,
    data: {
      bookingId: booking._id.toString(),
      studentId: booking.studentId.toString(),
      date: booking.date,
      startTime: booking.startTime,
    },
  }).catch((err) =>
    console.error("Error creating tutor completion notification:", err)
  );

  return new ApiResponse(200, "Booking marked as completed", booking.toJSON());
};

/* ── No-Show ── */

export const noShowBookingService = async (
  bookingId: string,
  userId: string,
  role: string
) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  const isBookingTutor = booking.tutorId.toString() === userId;
  const isAdmin = role === "admin";

  if (!isBookingTutor && !isAdmin) {
    throw new ApiError(
      403,
      "You are not authorized to mark this booking as no-show"
    );
  }

  if (booking.status !== "confirmed") {
    throw new ApiError(
      400,
      `Cannot mark no-show for a booking with status "${booking.status}"`
    );
  }

  booking.status = "no_show";
  await booking.save();

  await User.findByIdAndUpdate(booking.tutorId, {
    $inc: { totalLessons: 1 },
  });

  return new ApiResponse(200, "Booking marked as no-show", booking.toJSON());
};

/* ── Upcoming Bookings (dashboard widget) ── */

export const upcomingBookingsService = async (
  userId: string,
  role: string,
  query: IUpcomingQuery
) => {
  const limit = parseInt(query.limit || "5", 10);
  const today = new Date().toISOString().split("T")[0];

  const filter: any = {
    status: { $in: ["pending", "confirmed"] },
    date: { $gte: today },
  };

  if (role === "student") {
    filter.studentId = userId;
  } else if (role === "tutor") {
    filter.tutorId = userId;
  }

  const bookings = await Booking.find(filter)
    .populate(
      "studentId",
      "firstname lastname profilePicture learningPreferences address"
    )
    .populate(
      "tutorId",
      "firstname lastname profilePicture specializations hourlyRate"
    )
    .sort({ date: 1, startTime: 1 })
    .limit(limit);

  return new ApiResponse(200, "Upcoming bookings retrieved successfully", {
    bookings: bookings.map((b) => b.toJSON()),
  });
};

/* ── Booking Stats ── */

export const bookingStatsService = async (userId: string, role: string) => {
  const roleFilter: any = {};
  if (role === "student") {
    roleFilter.studentId = userId;
  } else if (role === "tutor") {
    roleFilter.tutorId = userId;
  }

  const [total, pending, confirmed, completed, cancelled, noShows] =
    await Promise.all([
      Booking.countDocuments(roleFilter),
      Booking.countDocuments({ ...roleFilter, status: "pending" }),
      Booking.countDocuments({ ...roleFilter, status: "confirmed" }),
      Booking.countDocuments({ ...roleFilter, status: "completed" }),
      Booking.countDocuments({
        ...roleFilter,
        status: {
          $in: ["cancelled_student", "cancelled_tutor", "cancelled_admin"],
        },
      }),
      Booking.countDocuments({ ...roleFilter, status: "no_show" }),
    ]);

  const today = new Date().toISOString().split("T")[0];
  const upcoming = await Booking.countDocuments({
    ...roleFilter,
    status: { $in: ["pending", "confirmed"] },
    date: { $gte: today },
  });

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const monthStr = startOfMonth.toISOString().split("T")[0];

  const monthBookings = await Booking.find({
    ...roleFilter,
    status: "completed",
    date: { $gte: monthStr },
  });

  const hoursThisMonth = monthBookings.length;
  const earningsThisMonth = monthBookings.reduce((sum, b) => sum + b.price, 0);
  const totalSpent = (
    await Booking.find({
      ...roleFilter,
      paymentStatus: { $in: ["paid", "free"] },
    })
  ).reduce((sum, b) => sum + b.price, 0);

  return new ApiResponse(200, "Booking stats retrieved successfully", {
    total,
    pending,
    confirmed,
    completed,
    cancelled,
    noShows,
    upcoming,
    hoursThisMonth,
    earningsThisMonth,
    totalSpent,
  });
};

/* ── Flag / Unflag Booking (admin) ── */

export const flagBookingService = async (
  bookingId: string,
  data: { flagged: boolean; flagReason?: string }
) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  booking.flagged = data.flagged;
  booking.flagReason = data.flagged ? data.flagReason || undefined : undefined;
  await booking.save();

  const action = data.flagged ? "flagged" : "unflagged";
  return new ApiResponse(
    200,
    `Booking ${action} successfully`,
    booking.toJSON()
  );
};

/* ── Admin Lesson Stats ── */

export const adminLessonStatsService = async () => {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const currentHHmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const [
    totalLessons,
    completedLessons,
    cancelledLessons,
    noShowLessons,
    trialLessons,
    flaggedLessons,
  ] = await Promise.all([
    Booking.countDocuments({}),
    Booking.countDocuments({ status: "completed" }),
    Booking.countDocuments({
      status: {
        $in: ["cancelled_student", "cancelled_tutor", "cancelled_admin"],
      },
    }),
    Booking.countDocuments({ status: "no_show" }),
    Booking.countDocuments({ type: "trial" }),
    Booking.countDocuments({ flagged: true }),
  ]);

  const upcomingLessons = await Booking.countDocuments({
    status: { $in: ["pending", "confirmed"] },
    date: { $gte: today },
  });

  const inProgressLessons = await Booking.countDocuments({
    status: "confirmed",
    date: today,
    startTime: { $lte: currentHHmm },
    endTime: { $gt: currentHHmm },
  });

  const financials = await Transaction.aggregate([
    { $match: { status: "paid" } },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: "$amount" },
        totalCommission: { $sum: "$platformCommission" },
      },
    },
  ]);

  const totalRevenue = financials[0]?.totalRevenue || 0;
  const totalCommission = financials[0]?.totalCommission || 0;

  const finishedLessons = completedLessons + noShowLessons;
  const totalAttempted = finishedLessons + cancelledLessons;
  const completionRate =
    totalAttempted > 0
      ? Math.round((finishedLessons / totalAttempted) * 1000) / 10
      : 0;

  const Review = require("../models/Review").default;
  const ratingResult = await Review.aggregate([
    { $match: { status: "published" } },
    { $group: { _id: null, avg: { $avg: "$rating" } } },
  ]);
  const avgRating = Math.round((ratingResult[0]?.avg || 0) * 10) / 10;

  return new ApiResponse(200, "Admin lesson stats retrieved successfully", {
    totalLessons,
    completedLessons,
    upcomingLessons,
    cancelledLessons,
    noShowLessons,
    inProgressLessons,
    trialLessons,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalCommission: Math.round(totalCommission * 100) / 100,
    completionRate,
    avgRating,
    flaggedLessons,
  });
};

/* ── Update Meeting URL (tutor) ── */

export const updateMeetingUrlService = async (
  bookingId: string,
  tutorId: string,
  meetingUrl: string
) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  if (booking.tutorId.toString() !== tutorId) {
    throw new ApiError(
      403,
      "You are not authorized to update this booking's meeting link"
    );
  }

  if (
    booking.status === "completed" ||
    booking.status === "no_show" ||
    booking.status.startsWith("cancelled")
  ) {
    throw new ApiError(
      400,
      `Cannot update meeting link for a booking with status "${booking.status}"`
    );
  }

  booking.meetingUrl = meetingUrl;
  await booking.save();

  // Notify the student that the meeting link was updated
  const tutor = await User.findById(tutorId).select("firstname lastname");

  createNotification({
    userId: booking.studentId,
    type: "booking_updated" as any,
    title: "Meeting Link Updated",
    message: `${tutor?.firstname || "Your tutor"} ${tutor?.lastname || ""} has updated the meeting link for your lesson on ${booking.date} at ${booking.startTime}.`,
    data: {
      bookingId: booking._id.toString(),
      date: booking.date,
      startTime: booking.startTime,
      meetingUrl,
    },
  }).catch((err) =>
    console.error("Error creating meeting URL update notification:", err)
  );

  return new ApiResponse(
    200,
    "Meeting link updated successfully",
    booking.toJSON()
  );
};
