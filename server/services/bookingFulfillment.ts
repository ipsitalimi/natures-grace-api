import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchUserNotification } from "./notificationDispatch";
import { fetchCommissionRate } from "./platformSettings";

export type BookingDraft = {
  practitionerId: string;
  offeringId?: string;
  clientName: string;
  clientEmail?: string;
  serviceName: string;
  sessionDate: string;
  sessionTime: string;
  durationMinutes: number;
  amountInr: number;
  feeBreakdown?: {
    serviceAmountInr: number;
    platformFeeInr: number;
    platformGstInr: number;
    totalInr: number;
  };
  notes?: string;
};

export async function savePendingBookingCheckout(
  supabase: SupabaseClient,
  userId: string,
  razorpayOrderId: string,
  booking: BookingDraft
): Promise<void> {
  const { error } = await supabase.from("pending_booking_checkouts").upsert(
    {
      user_id: userId,
      razorpay_order_id: razorpayOrderId,
      booking_draft: booking,
      fulfilled_at: null,
      booking_id: null,
    },
    { onConflict: "razorpay_order_id" }
  );

  if (error) {
    throw new Error(`Could not save booking checkout draft: ${error.message}`);
  }
}

/** Booking creation + practitioner earning ledger are committed atomically by the DB RPC. */
export async function fulfillBookingPayment(params: {
  supabase: SupabaseClient;
  userId: string;
  razorpayOrderId: string;
  paymentId: string;
  booking?: BookingDraft;
  commissionRate?: number;
}): Promise<
  | { ok: true; bookingId: string; bookingNumber: string; alreadyPaid: boolean }
  | { ok: false; error: string }
> {
  const { supabase, userId, razorpayOrderId, paymentId } = params;
  const commissionRate = params.commissionRate ?? (await fetchCommissionRate(supabase));

  const { data, error } = await supabase.rpc("fulfill_paid_booking_checkout", {
    p_user_id: userId,
    p_razorpay_order_id: razorpayOrderId,
    p_payment_id: paymentId,
    p_commission_rate: commissionRate,
  });

  if (error) return { ok: false, error: error.message };

  const result = data as {
    ok?: boolean;
    error?: string;
    booking_id?: string;
    booking_number?: string;
    already_paid?: boolean;
  } | null;

  if (!result?.ok || !result.booking_id || !result.booking_number) {
    return { ok: false, error: result?.error ?? "Booking fulfillment failed" };
  }

  // Notifications are intentionally outside the transaction. A notification
  // failure must not roll back or duplicate a paid booking/wallet entry.
  if (!result.already_paid) {
    const { data: pending } = await supabase
      .from("pending_booking_checkouts")
      .select("booking_draft")
      .eq("razorpay_order_id", razorpayOrderId)
      .maybeSingle();

    const draft = pending?.booking_draft as BookingDraft | null;
    if (draft) {
      try {
        await dispatchUserNotification(supabase, {
          userId,
          event: "booking_confirmed",
          message: `Session booked: ${draft.serviceName} on ${draft.sessionDate}.`,
          linkRoute: "SessionDetail",
          linkTargetId: result.booking_id,
          emailVars: {
            practitioner: draft.serviceName,
            date: draft.sessionDate,
            time: draft.sessionTime,
            service: draft.serviceName,
          },
        });
      } catch (notificationError) {
        console.error("[bookingFulfillment] booking notification failed");
      }
    }
  }

  return {
    ok: true,
    bookingId: result.booking_id,
    bookingNumber: result.booking_number,
    alreadyPaid: Boolean(result.already_paid),
  };
}
