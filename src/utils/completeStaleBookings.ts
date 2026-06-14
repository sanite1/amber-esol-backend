import Booking from "../models/Booking";
import { creditTutorForCompletedLesson } from "../services/payment.service";
import { createNotification } from "../services/notification.service";
import User from "../models/User";
import logger from "../config/logger";
import { hasLessonEnded, todayInTz } from "./timezone";
import { lessonDurationHours } from "./timeHelpers";

export const completeStaleBookings = async (
  userId: string,
  role: "student" | "tutor",
) => {
  const todayStr = todayInTz("Europe/London");
  const now = new Date();

  const filter: any = {
    status: "confirmed",
    date: { $lte: todayStr },
    ...(role === "student" ? { studentId: userId } : { tutorId: userId }),
  };

  const staleBookings = await Booking.find(filter);

  for (const booking of staleBookings) {
    try {
      const tz = booking.timezone || "Europe/London";

      // 30-minute grace period
      if (!hasLessonEnded(booking.date, booking.endTime, tz, 30)) continue;

      booking.status = "completed";
      booking.completedAt = now;
      await booking.save();

      await creditTutorForCompletedLesson(booking._id.toString());

      await User.findByIdAndUpdate(booking.tutorId, {
        $inc: { totalLessons: 1 },
      });
      await User.findByIdAndUpdate(booking.studentId, {
        $inc: {
          totalLessonsTaken: 1,
          totalHoursLearned: lessonDurationHours(
            booking.startTime,
            booking.endTime,
          ),
        },
      });

      await createNotification({
        userId: booking.studentId.toString(),
        type: "booking_completed",
        title: "Lesson Completed",
        message: "Your lesson has been marked as completed.",
        data: { bookingId: booking._id },
      });

      await createNotification({
        userId: booking.tutorId.toString(),
        type: "booking_completed",
        title: "Lesson Completed",
        message: "A lesson has been marked as completed.",
        data: { bookingId: booking._id },
      });
    } catch (err) {
      logger.error(
        { err, bookingId: booking._id },
        "Error auto-completing stale booking on dashboard load",
      );
    }
  }
};
