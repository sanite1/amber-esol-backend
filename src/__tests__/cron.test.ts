import { createStudent, createTutor, createBooking } from "./helpers";
import Booking from "../models/Booking";
import User from "../models/User";

jest.mock("../services/nodemailer/mail.service", () => ({
  sendLessonCompletedMail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/notification.service", () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/payment.service", () => ({
  creditTutorForCompletedLesson: jest.fn().mockResolvedValue(undefined),
}));

import { autoCompleteLessonsService } from "../services/cron.service";

describe("Auto-complete Cron", () => {
  let student: any;
  let tutor: any;

  beforeEach(async () => {
    student = await createStudent();
    tutor = await createTutor();
  });

  it("completes lessons that ended 30+ minutes ago", async () => {
    // Lesson ended 2 hours ago
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const dateStr = twoHoursAgo.toISOString().split("T")[0];
    const endH = String(twoHoursAgo.getHours()).padStart(2, "0");
    const endM = String(twoHoursAgo.getMinutes()).padStart(2, "0");
    const startH = String(twoHoursAgo.getHours() - 1).padStart(2, "0");

    await createBooking(student._id, tutor._id, {
      status: "confirmed",
      date: dateStr,
      startTime: `${startH}:${endM}`,
      endTime: `${endH}:${endM}`,
    });

    const result = await autoCompleteLessonsService();

    expect(result.completed).toBe(1);

    const updatedTutor = await User.findById(tutor._id);
    expect(updatedTutor!.totalLessons).toBe(1);
  });

  it("skips lessons that ended less than 30 minutes ago", async () => {
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const dateStr = tenMinAgo.toISOString().split("T")[0];
    const endH = String(tenMinAgo.getHours()).padStart(2, "0");
    const endM = String(tenMinAgo.getMinutes()).padStart(2, "0");
    const startH = String(tenMinAgo.getHours() - 1).padStart(2, "0");

    await createBooking(student._id, tutor._id, {
      status: "confirmed",
      date: dateStr,
      startTime: `${startH}:${endM}`,
      endTime: `${endH}:${endM}`,
    });

    const result = await autoCompleteLessonsService();

    expect(result.completed).toBe(0);
  });

  it("skips non-confirmed bookings", async () => {
    await createBooking(student._id, tutor._id, {
      status: "pending",
      date: "2026-01-01",
      startTime: "10:00",
      endTime: "11:00",
    });

    const result = await autoCompleteLessonsService();

    expect(result.completed).toBe(0);
  });
});
