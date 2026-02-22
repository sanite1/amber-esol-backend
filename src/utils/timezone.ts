import moment from "moment-timezone";

/**
 * Build a real Date from the booking's date, time, and timezone.
 * Example: toDateInTz("2025-07-15", "10:00", "Europe/London")
 * → Date representing 2025-07-15T10:00 BST (which is 09:00 UTC)
 */
export const toDateInTz = (
  date: string,
  time: string,
  tz: string = "Europe/London"
): Date => {
  return moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", tz).toDate();
};

/**
 * Get "now" expressed in a timezone, returning both the
 * YYYY-MM-DD date string and HH:mm time string for that timezone.
 */
export const nowInTz = (
  tz: string = "Europe/London"
): { dateStr: string; timeStr: string; momentObj: moment.Moment } => {
  const m = moment.tz(tz);
  return {
    dateStr: m.format("YYYY-MM-DD"),
    timeStr: m.format("HH:mm"),
    momentObj: m,
  };
};

/**
 * Get today's date string in a timezone.
 */
export const todayInTz = (tz: string = "Europe/London"): string => {
  return moment.tz(tz).format("YYYY-MM-DD");
};

/**
 * Get the current HH:mm in a timezone.
 */
export const currentTimeInTz = (tz: string = "Europe/London"): string => {
  return moment.tz(tz).format("HH:mm");
};

/**
 * Check if a date string is today in the given timezone.
 */
export const isTodayInTz = (
  dateStr: string,
  tz: string = "Europe/London"
): boolean => {
  return dateStr === todayInTz(tz);
};

/**
 * Check if a lesson's start time has passed in the booking's timezone.
 */
export const hasLessonStarted = (
  date: string,
  startTime: string,
  tz: string = "Europe/London"
): boolean => {
  const lessonStart = toDateInTz(date, startTime, tz);
  return new Date() > lessonStart;
};

/**
 * Check if a lesson's end time + grace period has passed.
 */
export const hasLessonEnded = (
  date: string,
  endTime: string,
  tz: string = "Europe/London",
  graceMinutes: number = 0
): boolean => {
  const lessonEnd = toDateInTz(date, endTime, tz);
  return Date.now() - lessonEnd.getTime() > graceMinutes * 60 * 1000;
};
