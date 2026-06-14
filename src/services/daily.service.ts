import logger from "../config/logger";
import ApiError from "../errors/apiError";

const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_API_URL = "https://api.daily.co/v1";

interface DailyRoomResponse {
  id: string;
  name: string;
  url: string;
  created_at: string;
  config: Record<string, any>;
}

/**
 * Creates a Daily.co video room for a lesson.
 *
 * Room settings:
 *  - Private: false (public room, anyone with the link can join)
 *  - Max participants: 2 (tutor + student)
 *  - Expires: 30 min after lesson end time
 *  - Prejoin UI enabled so both parties can test mic/camera
 *
 * Falls back gracefully if DAILY_API_KEY is not set — returns null
 * so the tutor can still paste their own link.
 */
export const createDailyRoom = async (
  bookingId: string,
  lessonDate: string,
  endTime: string,
): Promise<string | null> => {
  if (!DAILY_API_KEY) {
    logger.warn("DAILY_API_KEY not set — skipping auto room creation");
    return null;
  }

  try {
    // Room expires 30 min after lesson ends
    const [endH, endM] = endTime.split(":").map(Number);
    const expiry = new Date(`${lessonDate}T00:00:00`);
    expiry.setHours(endH, endM + 30, 0, 0);
    const expUnix = Math.floor(expiry.getTime() / 1000);

    const roomName = `amber-${bookingId}`;

    const response = await fetch(`${DAILY_API_URL}/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DAILY_API_KEY}`,
      },
      body: JSON.stringify({
        name: roomName,
        privacy: "public",
        properties: {
          max_participants: 2,
          exp: expUnix,
          enable_prejoin_ui: true,
          enable_screenshare: true,
          enable_chat: true,
          enable_hand_raising: true,
          enable_noise_cancellation_ui: true,
          eject_at_room_exp: true,
          lang: "en",
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, body: errorBody },
        "Daily.co room creation failed",
      );

      return null;
    }

    const room: DailyRoomResponse = await response.json();
    return room.url;
  } catch (err: any) {
    logger.error({ err }, "Error creating Daily.co room");
    return null;
  }
};
