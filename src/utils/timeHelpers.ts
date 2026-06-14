export function lessonDurationHours(
  startTime?: string,
  endTime?: string,
): number {
  if (!startTime || !endTime) return 1;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const diffMins = eh * 60 + em - (sh * 60 + sm);

  if (diffMins <= 0) return 1;

  // 50-min slot = 1 hour (regular lesson: 50 min + 10 min break)
  if (diffMins === 50) return 1;

  // 20-min slot = 0.5 hours (trial lesson: 20 min + 10 min break)
  if (diffMins === 20) return 0.5;

  // Fallback: round up to the nearest slot
  return diffMins / 60;
}
