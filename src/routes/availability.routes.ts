import { Router } from "express";
import { isAuthenticated, isTutor } from "../middlewares/authMiddleWare";
import {
  getAvailabilityValidation,
  setScheduleValidation,
  updateSettingsValidation,
  createOverrideValidation,
  deleteOverrideValidation,
  getAvailableSlotsValidation,
} from "../validations/availability.validation";
import {
  getAvailability,
  setSchedule,
  updateSettings,
  createOverride,
  deleteOverride,
  getAvailableSlots,
} from "../controllers/availability.controller";

const router = Router();

// ── Public: get tutor availability ──
router.get("/:tutorId", getAvailabilityValidation(), getAvailability);

// ── Public: get computed available slots for a specific date ──
router.get("/:tutorId/slots", getAvailableSlotsValidation(), getAvailableSlots);

// ── Authenticated tutor: set/replace weekly schedule ──
router.put("/", isAuthenticated, isTutor, setScheduleValidation(), setSchedule);

// ── Authenticated tutor: update booking settings ──
router.patch(
  "/settings",
  isAuthenticated,
  isTutor,
  updateSettingsValidation(),
  updateSettings
);

// ── Authenticated tutor: create date override ──
router.post(
  "/overrides",
  isAuthenticated,
  isTutor,
  createOverrideValidation(),
  createOverride
);

// ── Authenticated tutor: delete date override ──
router.delete(
  "/overrides/:id",
  isAuthenticated,
  isTutor,
  deleteOverrideValidation(),
  deleteOverride
);

export default router;
