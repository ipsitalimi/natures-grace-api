import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_FREE_CANCELLATION_HOURS = 24;
const DEFAULT_CANCELLATION_FEE_PERCENT = 100;

export type BookingCancellationPolicy = {
  freeCancellationHours: number;
  cancellationFeePercent: number;
};

export type BookingRefundCalculation = {
  sessionStartsAt: string;
  hoursUntilSession: number;
  freeCancellation: boolean;
  cancellationFeePercent: number;
  refundPercent: number;
  refundAmountInr: number;
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export async function fetchBookingCancellationPolicy(
  supabase: SupabaseClient
): Promise<BookingCancellationPolicy> {
  const { data } = await supabase
    .from("platform_settings")
    .select("settings")
    .eq("id", "default")
    .maybeSingle();

  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  return {
    freeCancellationHours: boundedNumber(
      settings.freeCancellationHours,
      DEFAULT_FREE_CANCELLATION_HOURS,
      0,
      720
    ),
    cancellationFeePercent: boundedNumber(
      settings.cancellationFeePercent,
      DEFAULT_CANCELLATION_FEE_PERCENT,
      0,
      100
    ),
  };
}

/** Parse stored booking date/time in the app's India timezone (IST). */
export function getBookingSessionStart(sessionDate: string, sessionTime: string): Date | null {
  const date = sessionDate.trim();
  const time = sessionTime.trim();

  // ISO datetime stored in the date field already includes its own timezone.
  if (date.includes("T")) {
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // Booking dates are stored as YYYY-MM-DD and times commonly as 2:30 PM.
  const match = time.match(/^(\\d{1,2})(?::(\\d{2}))?\\s*(AM|PM)$/i);
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(date) && match) {
    let hours = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hours += 12;
    const minutes = Number(match[2] ?? "0");
    const parsed = new Date(`${date}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00+05:30`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // Fallback for ISO-like or parseable legacy formats.
  const parsed = new Date(`${date} ${time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function calculateBookingRefund(params: {
  amountInr: number;
  sessionDate: string;
  sessionTime: string;
  policy: BookingCancellationPolicy;
  now?: Date;
}): BookingRefundCalculation | { error: string } {
  const sessionStart = getBookingSessionStart(params.sessionDate, params.sessionTime);
  if (!sessionStart) {
    return { error: "Unable to determine session start time; refund requires manual review" };
  }

  const hoursUntilSession =
    (sessionStart.getTime() - (params.now ?? new Date()).getTime()) / 3_600_000;
  const freeCancellation = hoursUntilSession >= params.policy.freeCancellationHours;
  const feePercent = freeCancellation ? 0 : params.policy.cancellationFeePercent;
  const refundPercent = 100 - feePercent;
  const refundAmountInr = Math.round((Math.max(0, params.amountInr) * refundPercent) * 100) / 100;

  return {
    sessionStartsAt: sessionStart.toISOString(),
    hoursUntilSession,
    freeCancellation,
    cancellationFeePercent: feePercent,
    refundPercent,
    refundAmountInr,
  };
}
