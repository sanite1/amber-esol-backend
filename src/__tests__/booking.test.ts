/**
 * Brief §2 Change 4 — Standardise ESOL session rates.
 *
 * Asserts the pricing source of `createBookingService` for two cases:
 *   1. type: "esol_consolidation" → price = Organisation.esol_session_rate,
 *      regardless of teacher.hourlyRate
 *   2. type: "regular"            → price = teacher.hourlyRate
 */

// ── Module mocks (must be declared BEFORE the service import) ────────
//
// External side-effect services are stubbed so the test never sends an
// email, calls Stripe, hits Zoom, or invokes the notification service.
jest.mock("../services/nodemailer/mail.service", () => ({
  sendBookingRequestMail: jest.fn().mockResolvedValue(undefined),
  sendBookingPendingMail: jest.fn().mockResolvedValue(undefined),
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

jest.mock("../services/daily.service", () => ({
  createDailyRoom: jest.fn().mockResolvedValue("https://daily.co/fake"),
}));

jest.mock("../services/payment.service", () => ({
  creditTutorForCompletedLesson: jest.fn().mockResolvedValue(undefined),
}));

// Stripe ctor returns a fake client. createBookingService for `regular`
// bookings calls `stripe.checkout.sessions.create` — without this mock the
// service would try to hit the real Stripe API with a fake key.
jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          id: "cs_test_fake",
          url: "https://checkout.stripe.com/fake",
        }),
      },
    },
  }));
});

import { Types } from "mongoose";
import { createBookingService } from "../services/booking.service";
import { createStudent, createTutor } from "./helpers";
import Organisation from "../models/Organisation";
import Availability from "../models/Availability";
import Booking from "../models/Booking";
import OrgInvoice from "../models/OrgInvoice";
import Transaction from "../models/Transaction";
import Wallet from "../models/Wallet";

// ── Helpers ──────────────────────────────────────────────────────────

/** YYYY-MM-DD string `daysAhead` days from today. */
const futureSlotDate = (daysAhead = 2): string => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A complete 7-day weekly schedule, every day enabled, 09:00–18:00. */
const fullWeeklySchedule = () =>
  [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ].map((day) => ({
    day,
    enabled: true,
    blocks: [{ startTime: "09:00", endTime: "18:00" }],
  }));

// ── Tests ────────────────────────────────────────────────────────────

describe("ESOL session rate standardisation (brief §2 Change 4)", () => {
  // Distinct rate values so the test can tell which one ended up on the
  // booking — they must NEVER be equal.
  const ORG_ESOL_RATE = 30;
  const TEACHER_HOURLY_RATE = 50;

  let org: any;
  let learner: any;
  let teacher: any;

  beforeEach(async () => {
    org = await Organisation.create({
      name: "Test College",
      slug: `test-college-${Date.now()}`,
      contactEmail: "admin@test-college.test",
      contactName: "Test Admin",
      paymentModel: "invoiced",
      invoiceCycle: "monthly",
      adminUserId: new Types.ObjectId(),
      esol_session_rate: ORG_ESOL_RATE,
      billing_active: true,
    });

    learner = await createStudent({ orgId: org._id });

    teacher = await createTutor({
      hourlyRate: TEACHER_HOURLY_RATE,
      esolTeacherApproved: true,
      dbsCheckStatus: "cleared",
      languages: [{ name: "English", fluency: "native" }],
    });

    await Availability.create({
      tutorId: teacher._id,
      timezone: "Europe/London",
      weeklySchedule: fullWeeklySchedule(),
      maxBookingAdvance: 60,
      minBookingNotice: 0,
      bufferMinutes: 0,
    });
  });

  it("esol_consolidation: price = Organisation.esol_session_rate, NOT teacher.hourlyRate", async () => {
    const date = futureSlotDate(2);

    const result = await createBookingService(learner._id.toString(), {
      tutorId: teacher._id.toString(),
      type: "esol_consolidation",
      slots: [{ date, startTime: "10:00", endTime: "11:00" }],
    } as any);

    // Service returned a 201 ApiResponse
    expect(result.statusCode).toBe(201);

    // Booking persisted with the org's session rate as price
    const persisted = await Booking.findOne({ studentId: learner._id });
    expect(persisted).not.toBeNull();
    expect(persisted!.type).toBe("esol_consolidation");
    expect(persisted!.paymentStatus).toBe("org_invoiced");
    expect(persisted!.price).toBe(ORG_ESOL_RATE);
    expect(persisted!.price).not.toBe(TEACHER_HOURLY_RATE);

    // No Stripe checkout was issued (response carries the explicit null)
    expect((result.data as any).checkoutUrl).toBeNull();
    expect((result.data as any).invoicedToOrg).toBe(true);

    // OrgInvoice append landed — one draft invoice for this org/month
    const invoice = await OrgInvoice.findOne({
      orgId: org._id,
      status: "draft",
    });
    expect(invoice).not.toBeNull();
    expect(invoice!.subtotal).toBe(ORG_ESOL_RATE);

    // Teacher wallet credit + Transaction recorded with org_invoiced marker
    const wallet = await Wallet.findOne({ tutorId: teacher._id });
    expect(wallet).not.toBeNull();
    expect(wallet!.pendingBalance).toBe(ORG_ESOL_RATE * 0.8); // 20% platform commission
    const txn = await Transaction.findOne({ bookingId: persisted!._id });
    expect(txn).not.toBeNull();
    expect(txn!.paymentMethod).toBe("org_invoiced");
    expect(txn!.amount).toBe(ORG_ESOL_RATE);
  });

  it("regular: price = teacher.hourlyRate, NOT Organisation.esol_session_rate", async () => {
    // Marketplace path — student has no orgId so they're not org-scoped.
    const marketplaceStudent = await createStudent({ orgId: null });
    const date = futureSlotDate(2);

    const result = await createBookingService(
      marketplaceStudent._id.toString(),
      {
        tutorId: teacher._id.toString(),
        type: "regular",
        slots: [{ date, startTime: "10:00", endTime: "11:00" }],
      } as any,
    );

    expect(result.statusCode).toBe(201);

    const persisted = await Booking.findOne({
      studentId: marketplaceStudent._id,
    });
    expect(persisted).not.toBeNull();
    expect(persisted!.type).toBe("regular");
    expect(persisted!.price).toBe(TEACHER_HOURLY_RATE);
    expect(persisted!.price).not.toBe(ORG_ESOL_RATE);
    expect(persisted!.paymentStatus).toBe("pending"); // awaiting Stripe payment

    // Marketplace path issued a Stripe checkout (our mock returned the fake URL)
    expect((result.data as any).checkoutUrl).toBe(
      "https://checkout.stripe.com/fake",
    );
    expect((result.data as any).paymentRequired).toBe(true);

    // No OrgInvoice was created — marketplace bookings don't roll into an invoice
    const invoice = await OrgInvoice.findOne({});
    expect(invoice).toBeNull();
  });
});
