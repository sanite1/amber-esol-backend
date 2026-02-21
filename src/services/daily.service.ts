import ApiError from "../errors/apiError";

/**
 * Creates a Daily.co video room for a lesson.
 *
 * Free tier: 10,000 participant-minutes/month.
 * Rooms are public (no lobby/moderator gate), expire 2 hours
 * after the lesson's scheduled end time.
 *
 * Returns the full room URL (e.g. https://yourdomain.daily.co/amber-663f...)
 */
export const createDailyRoom = async (
  bookingId: string,
  lessonDate: string,
  endTime: string
): Promise<string> => {
  const DAILY_API_KEY = process.env.DAILY_API_KEY;

  if (!DAILY_API_KEY) {
    console.warn(
      "[daily] DAILY_API_KEY not set — falling back to no meeting URL"
    );
    return "";
  }

  // Room expires 2 hours after the lesson's scheduled end
  const [endH, endM] = endTime.split(":").map(Number);
  const expDate = new Date(`${lessonDate}T00:00:00`);
  expDate.setHours(endH, endM, 0, 0);
  expDate.setHours(expDate.getHours() + 2);
  const exp = Math.floor(expDate.getTime() / 1000);

  // Room name: alphanumeric + dash + underscore only, max 128 chars
  const roomName = `amber-${bookingId}`;

  try {
    const response = await fetch("https://api.daily.co/v1/rooms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DAILY_API_KEY}`,
      },
      body: JSON.stringify({
        name: roomName,
        privacy: "public",
        properties: {
          exp,
          max_participants: 2,
          enable_prejoin_ui: true,
          enable_screenshare: true,
          enable_chat: true,
          enable_knocking: false,
          start_video_off: false,
          start_audio_off: false,
          eject_at_room_exp: true,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        "[daily] Room creation failed:",
        response.status,
        errorBody
      );
      // Don't throw — booking confirmation should still succeed
      // Tutor can add their own link later
      return "";
    }

    const room = await response.json();
    return room.url as string;
  } catch (err: any) {
    console.error("[daily] Room creation error:", err.message);
    // Non-blocking: return empty string so confirmation isn't blocked
    return "";
  }
};
