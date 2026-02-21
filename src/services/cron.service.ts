import Booking from "../models/Booking";
import User from "../models/User";
import { creditTutorForCompletedLesson } from "./payment.service";
import { createNotification } from "./notification.service";

/**
 * Auto-complete confirmed lessons whose end time has passed by
 * at least 30 minutes. Designed to be called by a Vercel Cron Job
 * hitting GET /api/cron/complete-lessons.
 *
 * Mirrors the same logic as completeBookingService but runs in bulk
 * without requiring authentication.
 */
export const autoCompleteLessonsService = async () => {
  const now = new Date();

  // ── 1. Find all confirmed bookings whose lesson date is today or earlier ──
  // We'll do a precise time check in JS because date + endTime are stored
  // as separate string fields, not a single Date.
  const todayStr = now.toISOString().split("T")[0];

  const candidates = await Booking.find({
    status: "confirmed",
    date: { $lte: todayStr },
  });

  let completedCount = 0;
  const errors: string[] = [];

  for (const booking of candidates) {
    try {
      // ── 2. Build the real end-of-lesson datetime ──
      const [endH, endM] = booking.endTime.split(":").map(Number);
      const lessonEnd = new Date(`${booking.date}T00:00:00`);
      lessonEnd.setHours(endH, endM, 0, 0);

      // ── 3. Only complete if 30+ minutes have passed since lesson ended ──
      const minutesSinceEnd =
        (now.getTime() - lessonEnd.getTime()) / (1000 * 60);
      if (minutesSinceEnd < 30) continue;

      // ── 4. Mark as completed ──
      booking.status = "completed";
      booking.completedAt = now;
      await booking.save();

      // ── 5. Credit tutor wallet (pending → available) ──
      await creditTutorForCompletedLesson(booking._id.toString());

      // ── 6. Increment user stats (same as completeBookingService) ──
      await User.findByIdAndUpdate(booking.tutorId, {
        $inc: { totalLessons: 1 },
      });

      await User.findByIdAndUpdate(booking.studentId, {
        $inc: { totalLessonsTaken: 1, totalHoursLearned: 1 },
      });

      // ── 7. Notify both parties ──
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
        message: `Your ${booking.type} lesson on ${booking.date} with ${tutor?.firstname || "your tutor"} ${tutor?.lastname || ""} has been completed.`,
        data: {
          bookingId: booking._id.toString(),
          tutorId: booking.tutorId.toString(),
          date: booking.date,
          startTime: booking.startTime,
          autoCompleted: true,
        },
      }).catch((err) =>
        console.error(
          `[cron] Error notifying student ${booking.studentId}:`,
          err
        )
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
          autoCompleted: true,
        },
      }).catch((err) =>
        console.error(`[cron] Error notifying tutor ${booking.tutorId}:`, err)
      );

      // ── 8. Prompt student to leave a review ──
      createNotification({
        userId: booking.studentId,
        type: "review_prompt" as any,
        title: "How was your lesson?",
        message: `Your lesson with ${tutor?.firstname || "your tutor"} ${tutor?.lastname || ""} on ${booking.date} is complete. We'd love to hear your feedback!`,
        data: {
          bookingId: booking._id.toString(),
          tutorId: booking.tutorId.toString(),
          date: booking.date,
        },
      }).catch((err) =>
        console.error(
          `[cron] Error sending review prompt ${booking.studentId}:`,
          err
        )
      );

      completedCount++;
    } catch (err: any) {
      errors.push(`Booking ${booking._id}: ${err.message}`);
      console.error(`[cron] Failed to complete booking ${booking._id}:`, err);
    }
  }

  console.log(
    `[cron] Auto-complete finished: ${completedCount}/${candidates.length} bookings completed.`
  );

  return {
    processed: candidates.length,
    completed: completedCount,
    errors,
  };
};
