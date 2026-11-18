import type { SupabaseClient } from "@supabase/supabase-js";

type BookingForMeet = {
  id: string;
  booking_number: string;
  service_name: string;
  client_name: string;
  session_date: string;
  session_time: string;
  duration_minutes: number;
  meeting_link?: string | null;
  google_calendar_event_id?: string | null;
};

function parseSessionStart(date: string, time: string): string {
  const dateMatch = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) throw new Error("Booking date must use YYYY-MM-DD");

  const timeMatch = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
    ?? time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) throw new Error("Booking time format is not supported");

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3]?.toUpperCase();
  if (meridiem) {
    hour = hour % 12;
    if (meridiem === "PM") hour += 12;
  }
  if (hour > 23 || minute > 59) throw new Error("Booking time is invalid");

  return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function addMinutes(localDateTime: string, minutes: number): string {
  const [date, time] = localDateTime.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes, second));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

async function getAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google Calendar credentials are not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json() as { access_token?: string; error_description?: string; error?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? "Could not refresh Google access token");
  }
  return payload.access_token;
}

function makeGoogleEventId(bookingId: string): string {
  // Google Calendar event IDs allow only a-v and 0-9. Encode the UUID
  // into that alphabet so retries always target the same valid event ID.
  const alphabet = "abcdefghijklmnopqrstuv0123456789";
  const hex = bookingId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("Booking ID must be a UUID");
  let value = BigInt(`0x${hex}`);
  let encoded = "";
  for (let i = 0; i < 26; i += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `ng${encoded}`;
}

export async function ensureBookingMeetLink(
  supabase: SupabaseClient,
  bookingId: string
): Promise<void> {
  const { data: booking, error: readError } = await supabase
    .from("practitioner_bookings")
    .select("id, booking_number, service_name, client_name, session_date, session_time, duration_minutes, meeting_link, google_calendar_event_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (readError || !booking) {
    console.error("[googleMeet] Could not load booking for Meet creation", readError?.message);
    return;
  }

  const row = booking as BookingForMeet;
  if (row.google_calendar_event_id && row.meeting_link) return;

  try {
    const accessToken = await getAccessToken();
    const start = parseSessionStart(row.session_date, row.session_time);
    const end = addMinutes(start, Number(row.duration_minutes));
    const eventId = makeGoogleEventId(row.id);
    const requestId = eventId;

    const response = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: eventId,
          summary: `Nature's Grace — ${row.service_name}`,
          description: `Booking ${row.booking_number}\nClient: ${row.client_name}`,
          start: { dateTime: start, timeZone: "Asia/Kolkata" },
          end: { dateTime: end, timeZone: "Asia/Kolkata" },
          conferenceData: {
            createRequest: {
              requestId,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }),
      }
    );

    let event = await response.json() as {
      id?: string;
      hangoutLink?: string;
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
      error?: { message?: string };
    };

    // A retry after a successful Google insert but failed DB write finds the same event.
    if (response.status === 409) {
      const existingResponse = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (existingResponse.ok) {
        event = await existingResponse.json() as typeof event;
      }
    }

    const meetUrl = event.hangoutLink
      ?? event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;

    if ((!response.ok && response.status !== 409) || !event.id || !meetUrl) {
      throw new Error(event.error?.message ?? "Google Calendar did not return a Meet link");
    }

    const { error: updateError } = await supabase
      .from("practitioner_bookings")
      .update({
        google_calendar_event_id: event.id,
        meeting_link: meetUrl,
        meeting_creation_status: "created",
        meeting_creation_error: null,
      })
      .eq("id", bookingId);

    if (updateError) throw new Error(updateError.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Meet creation failed";
    await supabase
      .from("practitioner_bookings")
      .update({
        meeting_creation_status: "retry",
        meeting_creation_error: message.slice(0, 500),
      })
      .eq("id", bookingId);
    console.error("[googleMeet] Meet creation deferred", message);
  }
}
