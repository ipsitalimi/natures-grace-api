import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createPaidBooking,
  creditBookingEarning,
} from "./practitionerWalletLedger";
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
  notes?: string;
};

export async function savePendingBookingCheckout(
  supabase: SupabaseClient,
  userId: string,
  razorpayOrderId: string,
  booking: BookingDraft
): Promise<void> {
  await supabase.from("pending_booking_checkouts").upsert(
    {
      user_id: userId,
      razorpay_order_id: razorpayOrderId,
      booking_draft: booking,
      fulfilled_at: null,
      booking_id: null,
    },
    { onConflict: "razorpay_order_id" }
  );
}

/** Idempotent booking fulfillment from Razorpay payment. */
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

  const { data: pending } = await supabase
    .from("pending_booking_checkouts")
    .select("*")
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();

  if (pending?.fulfilled_at && pending.booking_id) {
    const { data: existing } = await supabase
      .from("practitioner_bookings")
      .select("id, booking_number")
      .eq("id", pending.booking_id)
      .maybeSingle();
    if (existing) {
      return {
        ok: true,
        bookingId: existing.id as string,
        bookingNumber: existing.booking_number as string,
        alreadyPaid: true,
      };
    }
  }

  const draft: BookingDraft | undefined =
    params.booking ??
    (pending?.booking_draft as BookingDraft | undefined);

  if (!draft) {
    return { ok: false, error: "Booking draft not found for payment" };
  }

  if (pending?.user_id && pending.user_id !== userId) {
    return { ok: false, error: "Checkout does not belong to this account" };
  }

  const { data: dup } = await supabase
    .from("practitioner_bookings")
    .select("id, booking_number")
    .eq("razorpay_payment_id", paymentId)
    .maybeSingle();

  if (dup) {
    return {
      ok: true,
      bookingId: dup.id as string,
      bookingNumber: dup.booking_number as string,
      alreadyPaid: true,
    };
  }

  const created = await createPaidBooking(supabase, {
    practitionerId: draft.practitionerId,
    offeringId: draft.offeringId,
    userId,
    clientName: draft.clientName,
    clientEmail: draft.clientEmail,
    serviceName: draft.serviceName,
    sessionDate: draft.sessionDate,
    sessionTime: draft.sessionTime,
    durationMinutes: Number(draft.durationMinutes),
    amount: Number(draft.amountInr),
    razorpayPaymentId: paymentId,
    notes: draft.notes,
  });

  if ("error" in created) {
    return { ok: false, error: created.error };
  }

  const commissionRate =
    params.commissionRate ?? (await fetchCommissionRate(supabase));

  const { data: bookingRow } = await supabase
    .from("practitioner_bookings")
    .select(
      "id, booking_number, practitioner_id, booking_status, payment_status, amount, service_name"
    )
    .eq("id", created.bookingId)
    .single();

  if (bookingRow) {
    await creditBookingEarning(
      supabase,
      bookingRow as {
        id: string;
        booking_number: string;
        practitioner_id: string | null;
        booking_status: string;
        payment_status: string;
        amount: number;
        service_name: string;
      },
      commissionRate
    );

    await dispatchUserNotification(supabase, {
      userId,
      event: "booking_confirmed",
      message: `Session booked: ${draft.serviceName} on ${draft.sessionDate}.`,
      linkRoute: "SessionDetail",
      linkTargetId: created.bookingId,
      emailVars: {
        practitioner: draft.serviceName,
        date: draft.sessionDate,
        time: draft.sessionTime,
        service: draft.serviceName,
      },
    });
  }

  await supabase
    .from("pending_booking_checkouts")
    .update({
      fulfilled_at: new Date().toISOString(),
      booking_id: created.bookingId,
    })
    .eq("razorpay_order_id", razorpayOrderId);

  return {
    ok: true,
    bookingId: created.bookingId,
    bookingNumber: created.bookingNumber,
    alreadyPaid: false,
  };
}
