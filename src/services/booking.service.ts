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
  sendPaymentSuccessMail,
} from "./nodemailer/mail.service";
import { creditTutorForCompletedLesson } from "./payment.service";
import { createNotification } from "./notification.service";
import Transaction from "../models/Transaction";
import Wallet from "../models/Wallet";

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

    // Check if student already had a trial with this tutor
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

    // Check date is not in the past
    const today = new Date().toISOString().split("T")[0];
    if (slotDate < today) {
      throw new ApiError(400, `Cannot book a slot in the past (${slotDate})`);
    }

    // Check date is within max booking advance
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + availability.maxBookingAdvance);
    const reqDate = new Date(slotDate + "T00:00:00Z");
    if (reqDate > maxDate) {
      throw new ApiError(
        400,
        `Date ${slotDate} is beyond the maximum booking advance of ${availability.maxBookingAdvance} days`
      );
    }

    // Check for existing booking conflict
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

    // Check date override (unavailable)
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
    // Create Stripe Checkout Session
    const lineItems = [
      {
        price_data: {
          currency: "gbp",
          product_data: {
            name: `${data.type === "trial" ? "Trial" : ""} Lesson with ${tutor.firstname} ${tutor.lastname}`.trim(),
            description: `${data.slots.length} × ${data.type === "trial" ? "30" : "60"}-minute session${data.slots.length > 1 ? "s" : ""}`,
          },
          unit_amount: Math.round(pricePerSlot * 100), // pence
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
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 min expiry
    });

    // Store checkout session ID on all bookings
    await Booking.updateMany(
      { _id: { $in: bookings.map((b) => b._id) } },
      { $set: { stripeCheckoutSessionId: session.id } }
    );

    checkoutUrl = session.url;
  }

  // 10. Send emails (non-blocking)
  const emailContext = {
    student,
    tutor,
    bookings,
    totalPrice,
    isTrial,
    bookingGroupId,
  };

  //   // Notify tutor of new booking request
  //   sendBookingRequestMail(emailContext).catch((err) =>
  //     console.error("Error sending booking request email:", err)
  //   );

  //   // Notify student that booking is pending
  //   sendBookingPendingMail(emailContext).catch((err) =>
  //     console.error("Error sending booking pending email:", err)
  //   );

  //   // If free + auto-confirm, also send confirmed email
  //   if (isFree && autoConfirm) {
  //     sendBookingConfirmedMail(emailContext).catch((err) =>
  //       console.error("Error sending booking confirmed email:", err)
  //     );
  //   }

  // 11. Send notifications
  const firstSlot = data.slots[0];
  const slotSummary =
    data.slots.length > 1
      ? `${data.slots.length} sessions starting ${firstSlot.date}`
      : `${firstSlot.date} at ${firstSlot.startTime}`;

  // Notify tutor about new booking request
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

  // If free + auto-confirm, also notify student of confirmation
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

/* ── Stripe Webhook Handler ── */

export const handleStripeWebhookService = async (
  rawBody: Buffer,
  signature: string
) => {
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    throw new ApiError(500, "Stripe webhook secret is not configured");
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err: any) {
    throw new ApiError(
      400,
      `Webhook signature verification failed: ${err.message}`
    );
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingIds = session.metadata?.bookingIds?.split(",") || [];

      if (bookingIds.length === 0) break;

      // Update all bookings to paid
      const bookings = await Booking.find({
        _id: { $in: bookingIds },
      });

      for (const booking of bookings) {
        booking.paymentStatus = "paid";
        booking.stripePaymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id;
        await booking.save();
      }

      // Create transaction records for each booking
      const PLATFORM_COMMISSION_RATE = 0.15;
      for (const booking of bookings) {
        const commission =
          Math.round(booking.price * PLATFORM_COMMISSION_RATE * 100) / 100;
        const tutorEarnings =
          Math.round((booking.price - commission) * 100) / 100;

        await Transaction.create({
          bookingId: booking._id,
          studentId: booking.studentId,
          tutorId: booking.tutorId,
          amount: booking.price,
          platformCommission: commission,
          tutorEarnings,
          currency: booking.currency,
          status: "paid",
          type: booking.type === "trial" ? "trial" : "lesson",
          paymentMethod: "card",
          stripePaymentIntentId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent?.id,
          stripeCheckoutSessionId: session.id,
        });

        // Credit tutor wallet (pending balance)
        let wallet = await Wallet.findOne({ tutorId: booking.tutorId });
        if (!wallet) {
          wallet = await Wallet.create({ tutorId: booking.tutorId });
        }
        wallet.pendingBalance += tutorEarnings;
        wallet.totalEarned += tutorEarnings;
        wallet.lifetimeEarnings += tutorEarnings;
        await wallet.save();
      }

      // Check if tutor has auto-accept enabled
      if (bookings.length > 0) {
        const tutor = await User.findById(bookings[0].tutorId);
        if (tutor?.teachingPreferences?.autoAcceptBookings) {
          await Booking.updateMany(
            { _id: { $in: bookingIds }, status: "pending" },
            { $set: { status: "confirmed" } }
          );

          // Re-fetch and send confirmed emails
          const updatedBookings = await Booking.find({
            _id: { $in: bookingIds },
          });
          const student = await User.findById(updatedBookings[0].studentId);

          if (student && tutor) {
            sendBookingConfirmedMail({
              student,
              tutor,
              bookings: updatedBookings,
              totalPrice: updatedBookings.reduce((sum, b) => sum + b.price, 0),
              isTrial: updatedBookings[0].type === "trial",
              bookingGroupId: updatedBookings[0].bookingGroupId,
            }).catch((err) =>
              console.error("Error sending confirmed email:", err)
            );

            // Notify student of auto-confirmation after payment
            createNotification({
              userId: student._id,
              type: "booking_confirmed",
              title: "Booking Confirmed",
              message: `Your lesson${updatedBookings.length > 1 ? "s" : ""} with ${tutor.firstname} ${tutor.lastname} on ${updatedBookings[0].date} ${updatedBookings.length > 1 ? `(${updatedBookings.length} sessions)` : `at ${updatedBookings[0].startTime}`} ha${updatedBookings.length > 1 ? "ve" : "s"} been confirmed.`,
              data: {
                bookingIds: updatedBookings.map((b) => b._id.toString()),
                tutorId: tutor._id.toString(),
                date: updatedBookings[0].date,
                startTime: updatedBookings[0].startTime,
              },
            }).catch((err) =>
              console.error("Error creating confirmed notification:", err)
            );
          }
        }

        // Send payment success email
        const student = await User.findById(bookings[0].studentId);
        if (student && tutor) {
          sendPaymentSuccessMail({
            student,
            tutor,
            bookings,
            totalPrice: bookings.reduce((sum, b) => sum + b.price, 0),
          }).catch((err) =>
            console.error("Error sending payment success email:", err)
          );

          // Notify student of successful payment
          const totalPaid = bookings.reduce((sum, b) => sum + b.price, 0);
          createNotification({
            userId: student._id,
            type: "payment_processed",
            title: "Payment Successful",
            message: `Payment of £${totalPaid.toFixed(2)} for your lesson${bookings.length > 1 ? "s" : ""} with ${tutor.firstname} ${tutor.lastname} on ${bookings[0].date} was processed successfully.`,
            data: {
              bookingIds: bookings.map((b) => b._id.toString()),
              amount: totalPaid,
              date: bookings[0].date,
              tutorId: tutor._id.toString(),
            },
          }).catch((err) =>
            console.error("Error creating payment notification:", err)
          );
        }
      }
      break;
    }

    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingIds = session.metadata?.bookingIds?.split(",") || [];

      if (bookingIds.length > 0) {
        // Fetch bookings before updating so we can notify
        const bookings = await Booking.find({
          _id: { $in: bookingIds },
          paymentStatus: "pending",
        });

        // Mark bookings as failed since payment expired
        await Booking.updateMany(
          { _id: { $in: bookingIds }, paymentStatus: "pending" },
          {
            $set: {
              paymentStatus: "failed",
              status: "cancelled_student",
              cancelReason: "Payment session expired",
              cancelledBy: "student",
              cancelledAt: new Date(),
            },
          }
        );

        // Notify student that payment expired
        if (bookings.length > 0) {
          createNotification({
            userId: bookings[0].studentId,
            type: "payment_failed",
            title: "Payment Expired",
            message: `Your payment session for the lesson on ${bookings[0].date} has expired. The booking has been cancelled.`,
            data: {
              bookingIds: bookings.map((b) => b._id.toString()),
              date: bookings[0].date,
            },
          }).catch((err) =>
            console.error("Error creating payment expired notification:", err)
          );
        }
      }
      break;
    }
  }

  return new ApiResponse(200, "Webhook processed successfully");
};

/* ── List Bookings (role-aware) ── */

export const listBookingsService = async (
  userId: string,
  role: string,
  query: IBookingQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  // Build filter based on role
  const filter: any = {};

  if (role === "student") {
    filter.studentId = userId;
  } else if (role === "tutor") {
    filter.tutorId = userId;
  }
  // Admin sees all bookings (no role filter)

  // Status filter
  if (query.status) {
    filter.status = query.status;
  }

  // Type filter
  if (query.type) {
    filter.type = query.type;
  }

  // Date range filter
  if (query.dateFrom || query.dateTo) {
    filter.date = {};
    if (query.dateFrom) filter.date.$gte = query.dateFrom;
    if (query.dateTo) filter.date.$lte = query.dateTo;
  }

  // Search by student or tutor name
  if (query.search) {
    const searchRegex = new RegExp(query.search, "i");

    // Find matching user IDs
    const matchingUsers = await User.find({
      $or: [{ firstname: searchRegex }, { lastname: searchRegex }],
    }).select("_id");

    const matchingIds = matchingUsers.map((u) => u._id);

    if (role === "student") {
      // Student searching by tutor name
      filter.tutorId = { $in: matchingIds };
    } else if (role === "tutor") {
      // Tutor searching by student name
      filter.studentId = { $in: matchingIds };
    } else {
      // Admin can search both
      filter.$or = [
        { studentId: { $in: matchingIds } },
        { tutorId: { $in: matchingIds } },
      ];
    }
  }

  // Sort
  let sortOption: any = { createdAt: -1 }; // default: newest
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

  // Authorization: ensure user is the student, tutor, or admin
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

  // For paid bookings, ensure payment is complete
  if (booking.paymentStatus !== "paid" && booking.paymentStatus !== "free") {
    throw new ApiError(
      400,
      "Cannot confirm booking — payment has not been received"
    );
  }

  booking.status = "confirmed";
  await booking.save();

  // Send confirmation email
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

  // Update tutor stats
  await User.findByIdAndUpdate(tutorId, {
    $inc: { totalStudents: 1 },
  });

  // Notify student that their booking has been confirmed
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

  // If payment was made, issue refund
  if (booking.paymentStatus === "paid" && booking.stripePaymentIntentId) {
    try {
      await stripe.refunds.create({
        payment_intent: booking.stripePaymentIntentId,
      });
      booking.paymentStatus = "refunded";
      await booking.save();
    } catch (err) {
      console.error("Stripe refund error:", err);
      // Don't block the decline — refund can be retried manually
    }
  }

  // Send declined email to student
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

  // Notify student that their booking has been declined
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

  // If refunded, also notify student about the refund
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

  // Authorization
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

  // Determine who is cancelling
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

  // Handle refund logic
  if (booking.paymentStatus === "paid" && booking.stripePaymentIntentId) {
    // Check if cancellation is 24+ hours before the lesson
    const lessonDateTime = new Date(`${booking.date}T${booking.startTime}:00Z`);
    const hoursUntilLesson =
      (lessonDateTime.getTime() - Date.now()) / (1000 * 60 * 60);

    if (
      hoursUntilLesson >= 24 ||
      cancelledBy === "tutor" ||
      cancelledBy === "admin"
    ) {
      // Full refund
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
    // If < 24 hours and student cancelled → no refund (per cancellation policy)
  }

  // Send cancellation emails
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

  // Notify the other party about the cancellation
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

  // If refunded, also notify the student
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

  // Only tutor or admin can mark complete
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

  // Update user stats
  await User.findByIdAndUpdate(booking.tutorId, {
    $inc: { totalLessons: 1 },
  });

  await User.findByIdAndUpdate(booking.studentId, {
    $inc: { totalLessonsTaken: 1, totalHoursLearned: 1 },
  });

  // Fetch names for notification messages
  const student = await User.findById(booking.studentId).select(
    "firstname lastname"
  );
  const tutor = await User.findById(booking.tutorId).select(
    "firstname lastname"
  );

  // Notify student
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

  // Notify tutor
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

  // Tutor still gets paid for no-shows
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

  // Upcoming
  const today = new Date().toISOString().split("T")[0];
  const upcoming = await Booking.countDocuments({
    ...roleFilter,
    status: { $in: ["pending", "confirmed"] },
    date: { $gte: today },
  });

  // This month aggregates
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const monthStr = startOfMonth.toISOString().split("T")[0];

  const monthBookings = await Booking.find({
    ...roleFilter,
    status: "completed",
    date: { $gte: monthStr },
  });

  const hoursThisMonth = monthBookings.length; // each booking = 1 hour
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
