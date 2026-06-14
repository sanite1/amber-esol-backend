import bcrypt from "bcrypt";
import User from "../models/User";
import Booking from "../models/Booking";
import Transaction from "../models/Transaction";
import Wallet from "../models/Wallet";
import { Types } from "mongoose";

export const createStudent = async (overrides = {}) => {
  return User.create({
    firstname: "Test",
    lastname: "Student",
    email: `student-${Date.now()}@test.com`,
    phoneNumber: "07000000000",
    password: await bcrypt.hash("Password1!", 10),
    role: "student",
    verified: true,
    isActive: true,
    status: "active",
    ...overrides,
  });
};

export const createTutor = async (overrides = {}) => {
  return User.create({
    firstname: "Test",
    lastname: "Tutor",
    email: `tutor-${Date.now()}@test.com`,
    phoneNumber: "07000000001",
    password: await bcrypt.hash("Password1!", 10),
    role: "tutor",
    verified: true,
    isActive: true,
    status: "active",
    hourlyRate: 25,
    trialLessonOffered: true,
    trialLessonPrice: 0,
    ...overrides,
  });
};

export const createBooking = async (
  studentId: string,
  tutorId: string,
  overrides = {},
) => {
  return Booking.create({
    studentId,
    tutorId,
    type: "regular",
    status: "confirmed",
    date: "2026-03-01",
    startTime: "10:00",
    endTime: "11:00",
    timezone: "Europe/London",
    price: 25,
    currency: "GBP",
    paymentStatus: "paid",
    ...overrides,
  });
};

export const createTransaction = async (
  bookingId: string | Types.ObjectId,
  studentId: string,
  tutorId: string,
  overrides = {},
) => {
  return Transaction.create({
    bookingId,
    studentId,
    tutorId,
    amount: 25,
    platformCommission: 3.75,
    tutorEarnings: 21.25,
    currency: "GBP",
    status: "paid",
    type: "lesson",
    paymentMethod: "card",
    ...overrides,
  });
};

export const createWallet = async (tutorId: string, overrides = {}) => {
  return Wallet.create({
    tutorId,
    availableBalance: 0,
    pendingBalance: 0,
    processingBalance: 0,
    totalEarned: 0,
    lifetimeEarnings: 0,
    ...overrides,
  });
};
