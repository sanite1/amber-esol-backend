import { createStudent, createTutor, createBooking } from "./helpers";
import User from "../models/User";
import Booking from "../models/Booking";
import Availability from "../models/Availability";

// Mock external services so tests don't send emails or call Zoom
jest.mock("../services/nodemailer/mail.service", () => ({
  sendBookingConfirmedMail: jest.fn().mockResolvedValue(undefined),
  sendBookingDeclinedMail: jest.fn().mockResolvedValue(undefined),
  sendBookingCancelledByStudentMail: jest.fn().mockResolvedValue(undefined),
  sendBookingCancelledByTutorMail: jest.fn().mockResolvedValue(undefined),
  sendLessonCompletedMail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/notification.service", () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/zoom.service", () => ({
  createZoomMeeting: jest.fn().mockResolvedValue("https://zoom.us/j/fake"),
}));
jest.mock("../services/payment.service", () => ({
  creditTutorForCompletedLesson: jest.fn().mockResolvedValue(undefined),
}));

import {
  confirmBookingService,
  declineBookingService,
  cancelBookingService,
  completeBookingService,
} from "../services/booking.service";

describe("Booking Lifecycle", () => {
  let student: any;
  let tutor: any;

  beforeEach(async () => {
    student = await createStudent();
    tutor = await createTutor();
    await Availability.create({
      tutorId: tutor._id,
      timezone: "Europe/London",
    });
  });

  describe("confirmBookingService", () => {
    it("confirms a pending paid booking", async () => {
      const booking = await createBooking(student._id, tutor._id, {
        status: "pending",
        paymentStatus: "paid",
      });

      const result = await confirmBookingService(
        booking._id.toString(),
        tutor._id.toString()
      );

      expect(result.statusCode).toBe(200);
      const updated = await Booking.findById(booking._id);
      expect(updated!.status).toBe("confirmed");
    });

    it("rejects confirmation by wrong tutor", async () => {
      const otherTutor = await createTutor();
      const booking = await createBooking(student._id, tutor._id, {
        status: "pending",
        paymentStatus: "paid",
      });

      await expect(
        confirmBookingService(booking._id.toString(), otherTutor._id.toString())
      ).rejects.toThrow("not authorized");
    });

    it("rejects confirmation of unpaid booking", async () => {
      const booking = await createBooking(student._id, tutor._id, {
        status: "pending",
        paymentStatus: "pending",
      });

      await expect(
        confirmBookingService(booking._id.toString(), tutor._id.toString())
      ).rejects.toThrow("payment has not been received");
    });

    it("rejects double confirmation", async () => {
      const booking = await createBooking(student._id, tutor._id, {
        status: "confirmed",
        paymentStatus: "paid",
      });

      await expect(
        confirmBookingService(booking._id.toString(), tutor._id.toString())
      ).rejects.toThrow("Cannot confirm");
    });

    it("increments totalStudents only on first booking", async () => {
      const booking1 = await createBooking(student._id, tutor._id, {
        status: "pending",
        paymentStatus: "paid",
      });

      await confirmBookingService(
        booking1._id.toString(),
        tutor._id.toString()
      );
      let updatedTutor = await User.findById(tutor._id);
      expect(updatedTutor!.totalStudents).toBe(1);

      const booking2 = await createBooking(student._id, tutor._id, {
        status: "pending",
        paymentStatus: "paid",
        date: "2026-03-02",
      });

      await confirmBookingService(
        booking2._id.toString(),
        tutor._id.toString()
      );
      updatedTutor = await User.findById(tutor._id);
      expect(updatedTutor!.totalStudents).toBe(1); // NOT 2
    });
  });

  describe("declineBookingService", () => {
    it("declines a pending booking", async () => {
      const booking = await createBooking(student._id, tutor._id, {
        status: "pending",
      });

      const result = await declineBookingService(
        booking._id.toString(),
        tutor._id.toString(),
        { reason: "Schedule conflict" }
      );

      expect(result.statusCode).toBe(200);
      const updated = await Booking.findById(booking._id);
      expect(updated!.status).toBe("cancelled_tutor");
      expect(updated!.cancelReason).toBe("Schedule conflict");
    });

    it("cannot decline an already confirmed booking", async () => {
      const booking = await createBooking(student._id, tutor._id, {
        status: "confirmed",
      });

      await expect(
        declineBookingService(booking._id.toString(), tutor._id.toString(), {})
      ).rejects.toThrow("Cannot decline");
    });
  });

  describe("cancelBookingService", () => {
    it("student can cancel a pending booking", async () => {
      const booking = await createBooking(student._id, tutor._id, {
        status: "pending",
      });

      const result = await cancelBookingService(
        booking._id.toString(),
        student._id.toString(),
        "student",
        { reason: "Changed plans" }
      );

      expect(result.statusCode).toBe(200);
      const updated = await Booking.findById(booking._id);
      expect(updated!.status).toBe("cancelled_student");
      expect(updated!.cancelledBy).toBe("student");
    });

    it("cannot cancel a completed booking", async () => {
      const booking = await createBooking(student._id, tutor._id, {
        status: "completed",
      });

      await expect(
        cancelBookingService(
          booking._id.toString(),
          student._id.toString(),
          "student",
          {}
        )
      ).rejects.toThrow("Cannot cancel");
    });

    it("unauthorized user cannot cancel", async () => {
      const stranger = await createStudent();
      const booking = await createBooking(student._id, tutor._id, {
        status: "confirmed",
      });

      await expect(
        cancelBookingService(
          booking._id.toString(),
          stranger._id.toString(),
          "student",
          {}
        )
      ).rejects.toThrow("not authorized");
    });
  });

  describe("completeBookingService", () => {
    it("completes a confirmed booking and increments stats", async () => {
      const booking = await createBooking(student._id, tutor._id, {
        status: "confirmed",
      });

      const result = await completeBookingService(
        booking._id.toString(),
        tutor._id.toString(),
        "tutor"
      );

      expect(result.statusCode).toBe(200);

      const updated = await Booking.findById(booking._id);
      expect(updated!.status).toBe("completed");
      expect(updated!.completedAt).toBeDefined();

      const updatedTutor = await User.findById(tutor._id);
      expect(updatedTutor!.totalLessons).toBe(1);

      const updatedStudent = await User.findById(student._id);
      expect(updatedStudent!.totalLessonsTaken).toBe(1);
    });

    it("cannot complete a pending booking", async () => {
      const booking = await createBooking(student._id, tutor._id, {
        status: "pending",
      });

      await expect(
        completeBookingService(
          booking._id.toString(),
          tutor._id.toString(),
          "tutor"
        )
      ).rejects.toThrow("Cannot complete");
    });
  });
});
