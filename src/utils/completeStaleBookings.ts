import Booking from "../models/Booking";
import { creditTutorForCompletedLesson } from "../services/payment.service";
import { createNotification } from "../services/notification.service";
import User from "../models/User";
import logger from "../config/logger";

export const completeStaleBookings = async (
  userId: string,
  role: "student" | "tutor"
) => {
  const now = new Date();
  const filter: any = {
    status: "confirmed",
    date: { $lte: now.toISOString().split("T")[0] },
    ...(role === "student" ? { studentId: userId } : { tutorId: userId }),
  };

  const staleBookings = await Booking.find(filter);

  for (const booking of staleBookings) {
    try {
      const [endH, endM] = (booking.endTime || "23:59").split(":").map(Number);
      const lessonEnd = new Date(booking.date + "T00:00:00");
      lessonEnd.setHours(endH, endM, 0, 0);

      // 30-minute grace period
      if (now.getTime() - lessonEnd.getTime() < 30 * 60 * 1000) continue;

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
          totalHoursLearned:
            booking.endTime && booking.startTime
              ? (parseInt(booking.endTime) - parseInt(booking.startTime)) / 60
              : 1,
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
        "Error auto-completing stale booking on dashboard load"
      );
    }
  }
};
