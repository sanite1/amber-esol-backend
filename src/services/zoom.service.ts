/**
 * Zoom Server-to-Server OAuth Integration
 *
 * Creates Zoom meetings for confirmed bookings.
 * Uses the Server-to-Server OAuth flow (no user interaction needed).
 *
 * Required env vars:
 *   ZOOM_ACCOUNT_ID
 *   ZOOM_CLIENT_ID
 *   ZOOM_CLIENT_SECRET
 *
 * Free Zoom account limitations:
 *   - 1:1 meetings (tutor + student) = unlimited duration
 *   - Up to 100 API-created meetings per day
 *   - No credit card required
 */

import logger from "../config/logger";

/* ── Token cache ── */
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Get a Zoom access token using Server-to-Server OAuth.
 * Tokens last 1 hour. We cache and reuse until 5 min before expiry.
 */
const getZoomAccessToken = async (): Promise<string> => {
  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error("Zoom credentials not configured");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error(
      { status: response.status, body: errorBody },
      "Zoom token request failed",
    );
    throw new Error(`Zoom token request failed: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // Token expires in ~3600s; cache it
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  return cachedToken!;
};

/**
 * Create a Zoom meeting for a lesson.
 *
 * Returns the join_url (for both participants) or null on failure.
 * Fails gracefully — if Zoom is down or creds are missing, the tutor
 * can still paste their own link via the override endpoint.
 */
export const createZoomMeeting = async (
  bookingId: string,
  lessonDate: string,
  startTime: string,
  endTime: string,
  tutorName: string,
  studentName: string,
  lessonType: string,
  specialty?: string,
): Promise<string | null> => {
  // Guard: skip if Zoom is not configured
  if (
    !process.env.ZOOM_ACCOUNT_ID ||
    !process.env.ZOOM_CLIENT_ID ||
    !process.env.ZOOM_CLIENT_SECRET
  ) {
    logger.warn("Zoom credentials not set — skipping meeting creation");
    return null;
  }

  try {
    const token = await getZoomAccessToken();

    // Build start time in ISO format
    const startDateTime = `${lessonDate}T${startTime}:00`;

    // Calculate duration in minutes
    const [sH, sM] = startTime.split(":").map(Number);
    const [eH, eM] = endTime.split(":").map(Number);
    const duration = eH * 60 + eM - (sH * 60 + sM);

    const topic = `${lessonType === "trial" ? "Trial " : ""}Lesson: ${tutorName} & ${studentName}${specialty ? ` — ${specialty}` : ""}`;

    const response = await fetch("https://api.zoom.us/v2/users/me/meetings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topic,
        type: 2, // Scheduled meeting
        start_time: startDateTime,
        duration: duration > 0 ? duration : 60,
        timezone: "Europe/London",
        settings: {
          join_before_host: true, // Student can join before tutor
          waiting_room: false, // No waiting room — direct join
          participant_video: true,
          host_video: true,
          mute_upon_entry: false,
          audio: "voip",
          auto_recording: "none",
          meeting_authentication: false,
          allow_multiple_devices: true,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, body: errorBody },
        "Zoom meeting creation failed",
      );
      return null;
    }

    const meeting = await response.json();
    logger.info({ meetingUrl: meeting.join_url }, "Zoom meeting created");

    return meeting.join_url;
  } catch (err: any) {
    logger.error({ err }, "Error creating Zoom meeting");
    return null;
  }
};
