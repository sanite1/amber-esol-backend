import {
  createStudent,
  createTutor,
  createBooking,
  createTransaction,
  createWallet,
} from "./helpers";
import Wallet from "../models/Wallet";
import Transaction from "../models/Transaction";
import Booking from "../models/Booking";

// Mock ALL mail functions that payment.service.ts imports
jest.mock("../services/nodemailer/mail.service", () => ({
  sendRefundIssuedMail: jest.fn().mockResolvedValue(undefined),
  sendPayoutRequestedMail: jest.fn().mockResolvedValue(undefined),
  sendPayoutCompletedMail: jest.fn().mockResolvedValue(undefined),
  sendPayoutRejectedMail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/notification.service", () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

// Mock Stripe entirely so no real API calls are made
jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    refunds: {
      create: jest.fn().mockResolvedValue({ id: "re_fake" }),
    },
    paymentIntents: {
      create: jest
        .fn()
        .mockResolvedValue({ id: "pi_fake", client_secret: "cs_fake" }),
      retrieve: jest
        .fn()
        .mockResolvedValue({ id: "pi_fake", client_secret: "cs_fake" }),
    },
    checkout: {
      sessions: {
        create: jest
          .fn()
          .mockResolvedValue({ id: "cs_fake", url: "https://fake.stripe.com" }),
      },
    },
  }));
});

import {
  creditTutorForCompletedLesson,
  requestPayoutService,
  refundTransactionService,
} from "../services/payment.service";

describe("Wallet & Payments", () => {
  let student: any;
  let tutor: any;

  beforeEach(async () => {
    student = await createStudent();
    tutor = await createTutor();
  });

  describe("creditTutorForCompletedLesson", () => {
    it("moves earnings from pending to available", async () => {
      const wallet = await createWallet(tutor._id, {
        pendingBalance: 21.25,
        totalEarned: 21.25,
      });

      const booking = await createBooking(student._id, tutor._id);
      await createTransaction(booking._id, student._id, tutor._id);

      await creditTutorForCompletedLesson(booking._id.toString());

      const updated = await Wallet.findById(wallet._id);
      expect(updated!.pendingBalance).toBe(0);
      expect(updated!.availableBalance).toBe(21.25);
    });

    it("does nothing for free lessons (no transaction)", async () => {
      const wallet = await createWallet(tutor._id);
      const booking = await createBooking(student._id, tutor._id, {
        price: 0,
        paymentStatus: "free",
      });

      await creditTutorForCompletedLesson(booking._id.toString());

      const updated = await Wallet.findById(wallet._id);
      expect(updated!.pendingBalance).toBe(0);
      expect(updated!.availableBalance).toBe(0);
    });
  });

  describe("requestPayoutService", () => {
    it("moves funds from available to processing", async () => {
      await createWallet(tutor._id, { availableBalance: 50 });

      const result = await requestPayoutService(tutor._id.toString(), {
        amount: 30,
        method: "bank_transfer",
      });

      expect(result.statusCode).toBe(201);

      const wallet = await Wallet.findOne({ tutorId: tutor._id });
      expect(wallet!.availableBalance).toBe(20);
      expect(wallet!.processingBalance).toBe(30);
    });

    it("rejects payout exceeding available balance", async () => {
      await createWallet(tutor._id, { availableBalance: 10 });

      await expect(
        requestPayoutService(tutor._id.toString(), {
          amount: 50,
          method: "bank_transfer",
        })
      ).rejects.toThrow("Insufficient balance");
    });

    it("rejects payout below minimum", async () => {
      await createWallet(tutor._id, { availableBalance: 100 });

      await expect(
        requestPayoutService(tutor._id.toString(), {
          amount: 5,
          method: "bank_transfer",
        })
      ).rejects.toThrow("Minimum payout");
    });

    it("rejects duplicate pending payout", async () => {
      await createWallet(tutor._id, { availableBalance: 100 });

      await requestPayoutService(tutor._id.toString(), {
        amount: 20,
        method: "bank_transfer",
      });

      await expect(
        requestPayoutService(tutor._id.toString(), {
          amount: 20,
          method: "bank_transfer",
        })
      ).rejects.toThrow("already have a pending payout");
    });
  });

  describe("refundTransactionService", () => {
    it("deducts from tutor wallet on refund", async () => {
      const wallet = await createWallet(tutor._id, {
        pendingBalance: 21.25,
        totalEarned: 21.25,
      });

      const booking = await createBooking(student._id, tutor._id);
      const tx = await createTransaction(booking._id, student._id, tutor._id, {
        stripePaymentIntentId: "pi_fake_123",
      });

      await refundTransactionService(
        tx._id.toString(),
        student._id.toString(),
        "student",
        { reason: "Not satisfied" }
      );

      const updatedWallet = await Wallet.findById(wallet._id);
      expect(updatedWallet!.pendingBalance).toBe(0);
      expect(updatedWallet!.totalEarned).toBe(0);

      const updatedTx = await Transaction.findById(tx._id);
      expect(updatedTx!.status).toBe("refunded");

      const updatedBooking = await Booking.findById(booking._id);
      expect(updatedBooking!.paymentStatus).toBe("refunded");
    });
  });
});
