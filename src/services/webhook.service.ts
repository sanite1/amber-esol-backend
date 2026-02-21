import Stripe from "stripe";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Booking from "../models/Booking";
import Transaction from "../models/Transaction";
import Wallet from "../models/Wallet";
import User from "../models/User";
import {
  sendBookingConfirmedMail,
  sendPaymentSuccessMail,
} from "./nodemailer/mail.service";
import { createNotification } from "./notification.service";

/* ── Stripe init ── */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

const PLATFORM_COMMISSION_RATE = 0.15;

/* ── Helper: get or create wallet ── */

const getOrCreateWallet = async (tutorId: string) => {
  let wallet = await Wallet.findOne({ tutorId });
  if (!wallet) {
    wallet = await Wallet.create({ tutorId });
  }
  return wallet;
};

/* ══════════════════════════════════════════════
   Unified Stripe Webhook Handler
   ══════════════════════════════════════════════ */

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
    /* ────────────────────────────────────────────
       CHECKOUT SESSION COMPLETED
       Fired when a student completes the Checkout page.
       Creates transactions, credits wallets, optionally
       auto-confirms bookings.
       ──────────────────────────────────────────── */
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
      for (const booking of bookings) {
        // Guard: skip if transaction already exists for this booking
        const existingTx = await Transaction.findOne({
          bookingId: booking._id,
          status: "paid",
        });
        if (existingTx) continue;

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
        const wallet = await getOrCreateWallet(booking.tutorId.toString());
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

          // ── Auto-generate Daily rooms for auto-accepted bookings ──
          const { createDailyRoom } = require("./daily.service");
          const confirmedBookings = await Booking.find({
            _id: { $in: bookingIds },
            status: "confirmed",
            meetingUrl: { $exists: false },
          });
          for (const cb of confirmedBookings) {
            const dailyUrl = await createDailyRoom(
              cb._id.toString(),
              cb.date,
              cb.endTime
            );
            if (dailyUrl) {
              cb.meetingUrl = dailyUrl;
              await cb.save();
            }
          }

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
        const tutor2 = await User.findById(bookings[0].tutorId);
        if (student && tutor2) {
          sendPaymentSuccessMail({
            student,
            tutor: tutor2,
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
            message: `Payment of £${totalPaid.toFixed(2)} for your lesson${bookings.length > 1 ? "s" : ""} with ${tutor2.firstname} ${tutor2.lastname} on ${bookings[0].date} was processed successfully.`,
            data: {
              bookingIds: bookings.map((b) => b._id.toString()),
              amount: totalPaid,
              date: bookings[0].date,
              tutorId: tutor2._id.toString(),
            },
          }).catch((err) =>
            console.error("Error creating payment notification:", err)
          );
        }
      }
      break;
    }

    /* ────────────────────────────────────────────
       CHECKOUT SESSION EXPIRED
       Fired when the Checkout page times out (30 min).
       Cancels the unpaid bookings.
       ──────────────────────────────────────────── */
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

    /* ────────────────────────────────────────────
       PAYMENT INTENT SUCCEEDED
       Fired for PaymentIntent-based payments (Stripe
       Elements / saved cards). Also fires after a
       Checkout Session completes, but the guards below
       prevent double-processing.
       ──────────────────────────────────────────── */
    case "payment_intent.succeeded": {
      const intent = event.data.object as Stripe.PaymentIntent;

      const transaction = await Transaction.findOne({
        stripePaymentIntentId: intent.id,
      });

      // Guard: only process if a matching pending transaction exists.
      // If checkout.session.completed already handled this payment,
      // the transaction will already be "paid" and we skip.
      if (transaction && transaction.status !== "paid") {
        transaction.status = "paid";
        await transaction.save();

        // Update booking payment status
        await Booking.findByIdAndUpdate(transaction.bookingId, {
          $set: {
            paymentStatus: "paid",
            stripePaymentIntentId: intent.id,
          },
        });

        // Credit tutor's wallet (pending until lesson completes)
        const wallet = await getOrCreateWallet(transaction.tutorId.toString());
        wallet.pendingBalance += transaction.tutorEarnings;
        wallet.totalEarned += transaction.tutorEarnings;
        wallet.lifetimeEarnings += transaction.tutorEarnings;
        await wallet.save();

        // Notify student of successful payment
        const booking = await Booking.findById(transaction.bookingId);
        const tutor = await User.findById(transaction.tutorId).select(
          "firstname lastname"
        );

        createNotification({
          userId: transaction.studentId,
          type: "payment_processed",
          title: "Payment Successful",
          message: `Your payment of £${transaction.amount.toFixed(2)} for the lesson${booking ? ` on ${booking.date}` : ""} with ${tutor?.firstname || "your tutor"} ${tutor?.lastname || ""} has been processed successfully.`,
          data: {
            transactionId: transaction._id.toString(),
            bookingId: transaction.bookingId.toString(),
            amount: transaction.amount,
            date: booking?.date || null,
          },
        }).catch((err) =>
          console.error("Error creating payment success notification:", err)
        );
      }
      break;
    }

    /* ────────────────────────────────────────────
       PAYMENT INTENT FAILED
       Fired when a PaymentIntent charge attempt fails.
       ──────────────────────────────────────────── */
    case "payment_intent.payment_failed": {
      const intent = event.data.object as Stripe.PaymentIntent;

      const transaction = await Transaction.findOne({
        stripePaymentIntentId: intent.id,
      });

      if (transaction) {
        transaction.status = "failed";
        await transaction.save();

        await Booking.findByIdAndUpdate(transaction.bookingId, {
          $set: { paymentStatus: "failed" },
        });

        // Notify student of failed payment
        const booking = await Booking.findById(transaction.bookingId);
        const tutor = await User.findById(transaction.tutorId).select(
          "firstname lastname"
        );

        createNotification({
          userId: transaction.studentId,
          type: "payment_failed",
          title: "Payment Failed",
          message: `Your payment of £${transaction.amount.toFixed(2)} for the lesson${booking ? ` on ${booking.date}` : ""} with ${tutor?.firstname || "your tutor"} ${tutor?.lastname || ""} could not be processed. Please try again or use a different payment method.`,
          data: {
            transactionId: transaction._id.toString(),
            bookingId: transaction.bookingId.toString(),
            amount: transaction.amount,
            date: booking?.date || null,
          },
        }).catch((err) =>
          console.error("Error creating payment failed notification:", err)
        );
      }
      break;
    }

    default:
      // Unhandled event type — acknowledge to Stripe, do nothing
      break;
  }

  return new ApiResponse(200, "Webhook processed successfully");
};
