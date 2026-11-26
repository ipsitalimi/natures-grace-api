import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureBookingMeetLink } from "./googleMeet";
import { sendTransactionalEmail } from "./email/emailService";
import { dispatchUserNotification } from "./notificationDispatch";
const PRACTITIONER_COMMISSION_RATE = 30;

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
  slotReservationId?: string;
};

export async function savePendingBookingCheckout(
  supabase: SupabaseClient,
  userId: string,
  razorpayOrderId: string,
  booking: BookingDraft,
  slotReservationId?: string
): Promise<void> {
  const { error } = await supabase.from("pending_booking_checkouts").upsert(
    {
      user_id: userId,
      razorpay_order_id: razorpayOrderId,
      booking_draft: booking,
      slot_reservation_id: slotReservationId ?? booking.slotReservationId ?? null,
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
  // Practitioner sessions use a fixed 30% platform commission. Seller orders continue
  // using the configurable global rate in orderFulfillment. The DB RPC also enforces 30%.
  const commissionRate = PRACTITIONER_COMMISSION_RATE;

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
    // A captured payment that cannot claim its slot is persisted for admin review.
    // Alert admins from both the customer-confirmation and webhook fulfillment paths.
    try {
      const { data: reconciliation } = await supabase
        .from("booking_payment_reconciliation")
        .select("razorpay_order_id, razorpay_payment_id, practitioner_id, session_date, session_time, reason, user_id")
        .eq("razorpay_order_id", razorpayOrderId)
        .maybeSingle();
      if (reconciliation) {
        const [{ data: admins }, { data: customer }] = await Promise.all([
          supabase.from("profiles").select("email").eq("role", "Admin").not("email", "is", null),
          supabase.from("profiles").select("full_name").eq("id", reconciliation.user_id).maybeSingle(),
        ]);
        const recipients = [...new Set((admins ?? []).map((row) => String(row.email ?? "").trim()).filter(Boolean))];
        await Promise.all(recipients.map((email) => sendTransactionalEmail(
          "booking_payment_reconciliation_admin",
          email,
          {
            orderId: reconciliation.razorpay_order_id,
            paymentId: reconciliation.razorpay_payment_id,
            customerId: customer?.full_name ?? reconciliation.user_id,
            practitionerId: reconciliation.practitioner_id ?? "Unavailable",
            sessionDate: reconciliation.session_date ?? "",
            sessionTime: reconciliation.session_time ?? "",
            reason: reconciliation.reason ?? "Slot conflict",
          },
          `booking-payment-reconciliation-${razorpayOrderId}-${email.toLowerCase()}`
        )));
      }
    } catch (alertError) {
      console.error("[bookingFulfillment] reconciliation admin alert failed");
    }
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
          suppressEmail: true,
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

/** Shared post-payment work for confirmation requests and Razorpay webhooks. */
export async function sendPaidBookingReceipts(supabase: SupabaseClient, bookingId: string, paymentId: string): Promise<void> {
  await ensureBookingMeetLink(supabase, bookingId);
  const { data: booking, error } = await supabase.from("practitioner_bookings").select("id, booking_number, user_id, practitioner_id, client_name, service_name, session_date, session_time, duration_minutes, amount, platform_fee_inr, platform_gst_inr, total_paid_amount_inr, meeting_link").eq("id", bookingId).maybeSingle();
  if (error || !booking) { console.error("[bookingFulfillment] receipt booking lookup failed", error?.message); return; }
  const [customer, practitioner, admins] = await Promise.all([supabase.from("profiles").select("email, full_name").eq("id", booking.user_id).maybeSingle(), supabase.from("practitioners").select("profile_id, name").eq("id", booking.practitioner_id).maybeSingle(), supabase.from("profiles").select("email, full_name").eq("role", "admin")]);
  const practitionerProfile = practitioner.data?.profile_id ? await supabase.from("profiles").select("email, full_name").eq("id", practitioner.data.profile_id).maybeSingle() : { data: null };
  const rupees = (value: unknown) => "INR " + Number(value ?? 0).toFixed(2);
  const vars = { bookingNumber: String(booking.booking_number ?? booking.id), customer: String(booking.client_name ?? customer.data?.full_name ?? "Customer"), practitioner: String(practitioner.data?.name ?? "Practitioner"), service: String(booking.service_name ?? "Session"), date: String(booking.session_date ?? ""), time: String(booking.session_time ?? ""), duration: String(booking.duration_minutes ?? ""), serviceAmount: rupees(booking.amount), platformFee: rupees(booking.platform_fee_inr), platformGst: rupees(booking.platform_gst_inr), totalPaid: rupees(booking.total_paid_amount_inr), paymentId, meetingLink: String(booking.meeting_link ?? "") };
  const recipients = [{ role: "customer", profile: customer.data }, { role: "practitioner", profile: practitionerProfile.data }, ...(admins.data ?? []).map((profile: { email?: string | null; full_name?: string | null }) => ({ role: "admin", profile }))];
  const sentTo = new Set<string>();
  for (const recipient of recipients) {
    const email = recipient.profile?.email?.trim().toLowerCase();
    if (!email || sentTo.has(email)) continue;
    sentTo.add(email);
    const emailHash = crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
    const key = "booking-" + bookingId + "-" + recipient.role + "-" + emailHash + "-receipt";
    const emailVars = { ...vars, name: recipient.profile?.full_name?.split(" ")[0] ?? "there", recipientRole: recipient.role };
    let result: Awaited<ReturnType<typeof sendTransactionalEmail>> = { ok: false, error: "Not attempted" };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      result = await sendTransactionalEmail("booking_confirmed", email, emailVars, key);
      if (result.ok || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
    if (!result.ok || ("skipped" in result && result.skipped)) console.error("[bookingFulfillment] receipt email not delivered", { role: recipient.role, error: result.ok ? "Email provider skipped" : result.error });
  }
}