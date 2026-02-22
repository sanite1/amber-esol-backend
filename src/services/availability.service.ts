import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Availability from "../models/Availability";
import DateOverride from "../models/DateOverride";
import User from "../models/User";
import {
  ISetScheduleRequest,
  IUpdateSettingsRequest,
  ICreateOverrideRequest,
  IAvailableSlotsQuery,
  ITimeBlock,
  DayOfWeek,
} from "../interfaces/availability.interface";
import Booking from "../models/Booking";
import moment from "moment-timezone";
import { nowInTz, todayInTz } from "../utils/timezone";

/* ── Helper: day name from a date string ── */

const getDayOfWeek = (dateStr: string): DayOfWeek => {
  const days: DayOfWeek[] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const d = new Date(dateStr + "T00:00:00Z");
  return days[d.getUTCDay()];
};

/* ── Helper: convert "HH:mm" to minutes since midnight ── */

const timeToMinutes = (time: string): number => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/* ── Helper: convert minutes since midnight to "HH:mm" ── */

const minutesToTime = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

/* ── Helper: generate time slots from blocks ── */

const generateSlots = (
  blocks: ITimeBlock[],
  durationMinutes: number,
  bufferMinutes: number
): { startTime: string; endTime: string }[] => {
  const slots: { startTime: string; endTime: string }[] = [];

  for (const block of blocks) {
    const blockStart = timeToMinutes(block.startTime);
    const blockEnd = timeToMinutes(block.endTime);

    let cursor = blockStart;
    while (cursor + durationMinutes <= blockEnd) {
      slots.push({
        startTime: minutesToTime(cursor),
        endTime: minutesToTime(cursor + durationMinutes),
      });
      cursor += durationMinutes + bufferMinutes;
    }
  }

  return slots;
};

/* ══════════════════════════════════════════════
   Service functions
   ══════════════════════════════════════════════ */

/* ── Get Availability ── */

export const getAvailabilityService = async (tutorId: string) => {
  // Verify tutor exists
  const tutor = await User.findById(tutorId);
  if (!tutor || tutor.role !== "tutor") {
    throw new ApiError(404, "Tutor not found");
  }

  // Get or create default availability
  let availability = await Availability.findOne({ tutorId });

  if (!availability) {
    availability = await Availability.create({
      tutorId,
      timezone: tutor.timezone || "Europe/London",
    });
  }

  // Get overrides
  const overrides = await DateOverride.find({ tutorId }).sort({ date: 1 });

  return new ApiResponse(200, "Availability retrieved successfully", {
    availability: availability.toJSON(),
    overrides: overrides.map((o) => o.toJSON()),
  });
};

/* ── Set / Replace Weekly Schedule ── */

export const setScheduleService = async (
  tutorId: string,
  data: ISetScheduleRequest
) => {
  // Validate that all 7 days are present and unique
  const days = data.weeklySchedule.map((d) => d.day);
  const uniqueDays = new Set(days);
  if (uniqueDays.size !== 7) {
    throw new ApiError(
      400,
      "Weekly schedule must contain exactly 7 unique days"
    );
  }

  // Validate time blocks: endTime > startTime, no overlaps within a day
  for (const daySchedule of data.weeklySchedule) {
    if (!daySchedule.enabled) continue;

    for (const block of daySchedule.blocks) {
      if (timeToMinutes(block.endTime) <= timeToMinutes(block.startTime)) {
        throw new ApiError(
          400,
          `${daySchedule.day}: End time must be after start time (${block.startTime} - ${block.endTime})`
        );
      }
    }

    // Check for overlapping blocks
    const sorted = [...daySchedule.blocks].sort(
      (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
    );
    for (let i = 1; i < sorted.length; i++) {
      if (
        timeToMinutes(sorted[i].startTime) <
        timeToMinutes(sorted[i - 1].endTime)
      ) {
        throw new ApiError(
          400,
          `${daySchedule.day}: Time blocks overlap (${sorted[i - 1].endTime} and ${sorted[i].startTime})`
        );
      }
    }
  }

  const updateData: any = { weeklySchedule: data.weeklySchedule };
  if (data.timezone) {
    updateData.timezone = data.timezone;
  }

  const availability = await Availability.findOneAndUpdate(
    { tutorId },
    { $set: updateData },
    { new: true, upsert: true, runValidators: true }
  );

  return new ApiResponse(200, "Weekly schedule updated successfully", {
    availability: availability.toJSON(),
  });
};

/* ── Update Booking Settings ── */

export const updateSettingsService = async (
  tutorId: string,
  data: IUpdateSettingsRequest
) => {
  const updateData: any = {};
  if (data.timezone !== undefined) updateData.timezone = data.timezone;
  if (data.bufferMinutes !== undefined)
    updateData.bufferMinutes = data.bufferMinutes;
  if (data.minBookingNotice !== undefined)
    updateData.minBookingNotice = data.minBookingNotice;
  if (data.maxBookingAdvance !== undefined)
    updateData.maxBookingAdvance = data.maxBookingAdvance;

  if (Object.keys(updateData).length === 0) {
    throw new ApiError(400, "No settings provided to update");
  }

  const availability = await Availability.findOneAndUpdate(
    { tutorId },
    { $set: updateData },
    { new: true, upsert: true, runValidators: true }
  );

  return new ApiResponse(200, "Booking settings updated successfully", {
    availability: availability.toJSON(),
  });
};

/* ── Create Date Override ── */

export const createOverrideService = async (
  tutorId: string,
  data: ICreateOverrideRequest
) => {
  // Get tutor's timezone for accurate "today" check
  const availability = await Availability.findOne({ tutorId });
  const tz = availability?.timezone || "Europe/London";
  const today = todayInTz(tz);

  // Validate date is not in the past
  if (data.date < today) {
    throw new ApiError(400, "Cannot create an override for a past date");
  }

  // Check if an override already exists for this date
  const existing = await DateOverride.findOne({ tutorId, date: data.date });
  if (existing) {
    throw new ApiError(
      400,
      `An override already exists for ${data.date}. Please remove it first.`
    );
  }

  // Validate time blocks for "extra" type
  if (data.type === "extra") {
    if (!data.blocks || data.blocks.length === 0) {
      throw new ApiError(
        400,
        "Extra availability must include at least one time block"
      );
    }

    for (const block of data.blocks) {
      if (timeToMinutes(block.endTime) <= timeToMinutes(block.startTime)) {
        throw new ApiError(
          400,
          `End time must be after start time (${block.startTime} - ${block.endTime})`
        );
      }
    }
  }

  const override = await DateOverride.create({
    tutorId,
    date: data.date,
    type: data.type,
    reason: data.reason,
    blocks: data.type === "extra" ? data.blocks : undefined,
  });

  return new ApiResponse(
    201,
    "Date override created successfully",
    override.toJSON()
  );
};

/* ── Delete Date Override ── */

export const deleteOverrideService = async (
  tutorId: string,
  overrideId: string
) => {
  const override = await DateOverride.findOneAndDelete({
    _id: overrideId,
    tutorId,
  });

  if (!override) {
    throw new ApiError(404, "Date override not found");
  }

  return new ApiResponse(200, "Date override removed successfully");
};

/* ── Get Available Slots for a Specific Date ── */

export const getAvailableSlotsService = async (
  tutorId: string,
  query: IAvailableSlotsQuery
) => {
  // Verify tutor exists
  const tutor = await User.findById(tutorId);
  if (!tutor || tutor.role !== "tutor") {
    throw new ApiError(404, "Tutor not found");
  }

  const availability = await Availability.findOne({ tutorId });
  if (!availability) {
    return new ApiResponse(200, "No availability configured", {
      date: query.date,
      slots: [],
      timezone: tutor.timezone || "Europe/London",
    });
  }

  const tz = availability.timezone || "Europe/London";
  const durationMinutes = parseInt(query.duration || "60", 10);
  const requestedDate = query.date;

  // 1. Check if the date is within the allowed booking window
  const { dateStr: todayStr, momentObj: nowMoment } = nowInTz(tz);

  if (requestedDate < todayStr) {
    return new ApiResponse(200, "Date is in the past", {
      date: requestedDate,
      slots: [],
      timezone: tz,
    });
  }

  const maxDate = moment.tz(tz).add(availability.maxBookingAdvance, "days");
  const reqMoment = moment.tz(requestedDate, "YYYY-MM-DD", tz);

  if (reqMoment.isAfter(maxDate, "day")) {
    return new ApiResponse(200, "Date is beyond the maximum booking advance", {
      date: requestedDate,
      slots: [],
      timezone: tz,
    });
  }

  // 2. Check for date overrides
  const override = await DateOverride.findOne({
    tutorId,
    date: requestedDate,
  });

  if (override) {
    if (override.type === "unavailable") {
      return new ApiResponse(200, "Tutor is unavailable on this date", {
        date: requestedDate,
        slots: [],
        timezone: tz,
        override: { type: "unavailable", reason: override.reason },
      });
    }

    if (override.type === "extra" && override.blocks) {
      const dayOfWeek = getDayOfWeek(requestedDate);
      const regularDay = availability.weeklySchedule.find(
        (d) => d.day === dayOfWeek
      );
      const regularBlocks =
        regularDay && regularDay.enabled ? regularDay.blocks : [];

      const allBlocks = [...regularBlocks, ...override.blocks];
      allBlocks.sort(
        (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
      );

      let slots = generateSlots(
        allBlocks,
        durationMinutes,
        availability.bufferMinutes
      );

      // Filter past slots if today
      if (requestedDate === todayStr) {
        const nowMinutes =
          nowMoment.hours() * 60 +
          nowMoment.minutes() +
          availability.minBookingNotice * 60;

        slots = slots.filter(
          (slot) => timeToMinutes(slot.startTime) >= nowMinutes
        );
      }

      // Filter booked slots
      const bookedSlots = await Booking.find({
        tutorId,
        date: requestedDate,
        status: { $in: ["pending", "confirmed"] },
      }).select("startTime endTime");

      slots = slots.filter((slot) => {
        const slotStart = timeToMinutes(slot.startTime);
        const slotEnd = timeToMinutes(slot.endTime);
        return !bookedSlots.some((b) => {
          const bookingStart = timeToMinutes(b.startTime);
          const bookingEnd = timeToMinutes(b.endTime);
          return slotStart < bookingEnd && slotEnd > bookingStart;
        });
      });

      return new ApiResponse(200, "Available slots retrieved successfully", {
        date: requestedDate,
        slots,
        timezone: tz,
        override: { type: "extra", reason: override.reason },
      });
    }
  }

  // 3. Use regular weekly schedule
  const dayOfWeek = getDayOfWeek(requestedDate);
  const daySchedule = availability.weeklySchedule.find(
    (d) => d.day === dayOfWeek
  );

  if (!daySchedule || !daySchedule.enabled || daySchedule.blocks.length === 0) {
    return new ApiResponse(200, "Tutor is not available on this day", {
      date: requestedDate,
      slots: [],
      timezone: tz,
    });
  }

  // 4. Generate slots
  const slots = generateSlots(
    daySchedule.blocks,
    durationMinutes,
    availability.bufferMinutes
  );

  // 5. If the requested date is today, filter out past slots
  let filteredSlots = slots;

  if (requestedDate === todayStr) {
    const nowMinutes =
      nowMoment.hours() * 60 +
      nowMoment.minutes() +
      availability.minBookingNotice * 60;

    filteredSlots = slots.filter(
      (slot) => timeToMinutes(slot.startTime) >= nowMinutes
    );
  }

  // 6. Filter out slots that overlap with existing bookings
  const bookedSlots = await Booking.find({
    tutorId,
    date: requestedDate,
    status: { $in: ["pending", "confirmed"] },
  }).select("startTime endTime");

  filteredSlots = filteredSlots.filter((slot) => {
    const slotStart = timeToMinutes(slot.startTime);
    const slotEnd = timeToMinutes(slot.endTime);

    return !bookedSlots.some((b) => {
      const bookingStart = timeToMinutes(b.startTime);
      const bookingEnd = timeToMinutes(b.endTime);
      return slotStart < bookingEnd && slotEnd > bookingStart;
    });
  });

  return new ApiResponse(200, "Available slots retrieved successfully", {
    date: requestedDate,
    slots: filteredSlots,
    timezone: tz,
  });
};
