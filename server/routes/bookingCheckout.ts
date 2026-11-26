import type { Express, Request, Response } from "express";
import {
  confirmBookingPayment,
  createBookingOrder,
} from "../services/razorpayCheckout";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireBearerUser } from "../middleware/auth";
import { calculateSessionPrice } from "../services/practitionerWalletLedger";
import {
  fulfillBookingPayment,
  savePendingBookingCheckout,
  type BookingDraft,
  sendPaidBookingReceipts,
} from "../services/bookingFulfillment";
import { calculateCheckoutTotal, fetchCheckoutFeeSettings, fetchCommissionRate } from "../services/platformSettings";
import { ensureBookingMeetLink } from "../services/googleMeet";

async function validateBookingAmount(
  practitionerId: string,
  durationMinutes: number,
  amountInr: number,
  offeringId?: string
): Promise<{ ok: true; amountInr: number } | { ok: false; error: string }> {
  const supabase = requireSupabaseAdmin();

  if (offeringId) {
    const { data: offering, error } = await supabase
      .from("practitioner_offerings")
      .select("practitioner_id, duration_minutes, price, is_active")
      .eq("id", offeringId)
      .maybeSingle();

    if (error || !offering) {
      return { ok: false, error: "Session offering not found" };
    }
    if ((offering as { practitioner_id: string }).practitioner_id !== practitionerId) {
      return { ok: false, error: "Offering does not belong to this practitioner" };
    }
    if (!(offering as { is_active: boolean }).is_active) {
      return { ok: false, error: "This session offering is no longer available" };
    }
    if (Number((offering as { duration_minutes: number }).duration_minutes) !== durationMinutes) {
      return { ok: false, error: "Duration does not match selected offering" };
    }

    const expected = Number((offering as { price: number }).price);
    if (Math.abs(expected - amountInr) > 0.01) {
      return { ok: false, error: "Booking amount does not match offering price" };
    }
    return { ok: true, amountInr: expected };
  }

  const { data: practitioner, error } = await supabase
    .from("practitioners")
    .select("price_per_session")
    .eq("id", practitionerId)
    .maybeSingle();

  if (error || !practitioner) {
    return { ok: false, error: "Practitioner not found" };
  }

  const expected = calculateSessionPrice(
    Number(practitioner.price_per_session),
    durationMinutes
  );

  if (Math.abs(expected - amountInr) > 0.01) {
    return { ok: false, error: "Booking amount does not match practitioner pricing" };
  }

  return { ok: true, amountInr: expected };
}

/** POST /api/bookings/checkout/create-order */
async function handleCreateOrder(req: Request, res: Response) {
  try {
    const user = await requireBearerUser(req, res);
    if (!user) {
      return;
    }

    const body = req.body as {
      practitionerId?: string;
      durationMinutes?: number;
      amountInr?: number;
      offeringId?: string;
      receipt?: string;
      booking?: BookingDraft;
    };

    if (!body.practitionerId || !body.durationMinutes || !body.amountInr || !body.booking) {
      return res.status(400).json({
        error: "practitionerId, durationMinutes, and amountInr are required",
      });
    }

    const validated = await validateBookingAmount(
      body.practitionerId,
      Number(body.durationMinutes),
      Number(body.amountInr),
      body.offeringId ?? body.booking?.offeringId
    );

    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }

    const supabase = requireSupabaseAdmin();
    const bookingDraft = body.booking;
    const offeringId = body.offeringId ?? bookingDraft.offeringId;
    if (!offeringId || !bookingDraft.sessionDate || !bookingDraft.sessionTime ||
        Number(bookingDraft.durationMinutes) !== Number(body.durationMinutes)) {
      return res.status(400).json({ error: "A complete booking slot and offering are required" });
    }

    const { data: reservation, error: reservationError } = await supabase.rpc("reserve_practitioner_slot", {
      p_user_id: user.id,
      p_practitioner_id: body.practitionerId,
      p_offering_id: offeringId,
      p_session_date: bookingDraft.sessionDate,
      p_session_time: bookingDraft.sessionTime,
      p_duration_minutes: Number(body.durationMinutes),
    });
    if (reservationError) return res.status(500).json({ error: "Could not reserve this session slot" });
    const reservationResult = reservation as { ok?: boolean; error?: string; reservation_id?: string } | null;
    if (!reservationResult?.ok || !reservationResult.reservation_id) {
      return res.status(409).json({ error: reservationResult?.error ?? "This session slot is unavailable" });
    }

    const feeSettings = await fetchCheckoutFeeSettings(supabase);
    const feeBreakdown = calculateCheckoutTotal(validated.amountInr, feeSettings);

    const result = await createBookingOrder({
      amountInr: feeBreakdown.totalInr,
      receipt: body.receipt ?? `bk_${user.id.slice(0, 8)}_${Date.now()}`,
      notes: {
        practitioner_id: body.practitionerId,
        user_id: user.id,
      },
    });

    if (!result.ok) {
      await supabase.rpc("release_practitioner_slot_reservation", {
        p_user_id: user.id, p_reservation_id: reservationResult.reservation_id,
      });
      return res.status(502).json({ error: result.error });
    }

    try {
      await savePendingBookingCheckout(supabase, user.id, result.orderId, {
        ...bookingDraft,
        offeringId,
        amountInr: validated.amountInr,
        feeBreakdown,
        slotReservationId: reservationResult.reservation_id,
      }, reservationResult.reservation_id);

      const { data: attached, error: attachError } = await supabase.rpc("attach_practitioner_slot_reservation", {
        p_user_id: user.id,
        p_reservation_id: reservationResult.reservation_id,
        p_razorpay_order_id: result.orderId,
      });
      if (attachError || attached !== true) {
        await supabase.rpc("release_practitioner_slot_reservation", {
          p_user_id: user.id, p_reservation_id: reservationResult.reservation_id,
        });
        return res.status(409).json({ error: "The slot reservation expired. Please select the time again." });
      }
    } catch (saveError) {
      await supabase.rpc("release_practitioner_slot_reservation", {
        p_user_id: user.id, p_reservation_id: reservationResult.reservation_id,
      });
      throw saveError;
    }

    const keyId = process.env.RAZORPAY_KEY_ID?.trim() ?? null;

    return res.json({
      orderId: result.orderId,
      amountPaise: result.amountPaise,
      amountInr: validated.amountInr,
      platformFeeInr: feeBreakdown.platformFeeInr,
      platformGstInr: feeBreakdown.platformGstInr,
      totalInr: feeBreakdown.totalInr,
      currency: result.currency,
      devMode: result.devMode ?? false,
      keyId,
    });
  } catch (err) {
    console.error("[bookingCheckout][server] create-order failed");
    const message = err instanceof Error ? err.message : "Create order failed";
    return res.status(500).json({ error: message });
  }
}

/** POST /api/bookings/checkout/confirm */
async function handleConfirmPayment(req: Request, res: Response) {
  try {
    const user = await requireBearerUser(req, res);
    if (!user) {
      return;
    }

    const { orderId, paymentId, signature, devMode } = req.body as {
      orderId?: string;
      paymentId?: string;
      signature?: string;
      devMode?: boolean;
    };

    if (!orderId) return res.status(400).json({ error: "orderId is required" });

    const supabase = requireSupabaseAdmin();
    const { data: pending, error: pendingError } = await supabase
      .from("pending_booking_checkouts")
      .select("user_id, booking_draft, fulfilled_at, booking_id")
      .eq("razorpay_order_id", orderId)
      .maybeSingle();

    if (pendingError || !pending || pending.user_id !== user.id) {
      return res.status(404).json({ error: "Checkout not found for this account" });
    }

    const booking = pending.booking_draft as BookingDraft | null;
    if (!booking) return res.status(400).json({ error: "Saved booking draft missing" });

    const validated = await validateBookingAmount(
      booking.practitionerId,
      Number(booking.durationMinutes),
      Number(booking.amountInr),
      booking.offeringId
    );
    if (!validated.ok) return res.status(400).json({ error: validated.error });

    const snapshot = booking.feeBreakdown;
    if (!snapshot || snapshot.serviceAmountInr !== validated.amountInr) {
      return res.status(400).json({ error: "Checkout fee snapshot is invalid" });
    }

    const verified = await confirmBookingPayment({
      orderId,
      paymentId: paymentId ?? "",
      signature,
      devMode,
      expectedAmountPaise: Math.round(Number(snapshot.totalInr) * 100),
    });

    if (!verified.ok) return res.status(400).json({ error: verified.error });

    const commissionRate = await fetchCommissionRate(supabase);
    const created = await fulfillBookingPayment({
      supabase,
      userId: user.id,
      razorpayOrderId: orderId,
      paymentId: verified.paymentId,
      commissionRate,
    });

    if (!created.ok) {
      const needsReview = created.error.startsWith("Payment received;");
      return res.status(needsReview ? 202 : 500).json({
        error: created.error,
        paymentId: verified.paymentId,
        orderId: verified.orderId,
        paymentReceived: needsReview,
        requiresAdminReview: needsReview,
      });
    }

    // Booking and wallet are committed; Meet creation is best-effort and cannot undo payment.
    await sendPaidBookingReceipts(supabase, created.bookingId, verified.paymentId);

    return res.json({
      paymentId: verified.paymentId,
      orderId: verified.orderId,
      bookingId: created.bookingId,
      bookingNumber: created.bookingNumber,
    });
  } catch (err) {
    console.error("[bookingCheckout][server] confirm failed");
    const message = err instanceof Error ? err.message : "Confirm failed";
    return res.status(500).json({ error: message });
  }
}


/** POST /api/bookings/free — confirm a zero-price offering without Razorpay. */
async function handleFreeBooking(req: Request, res: Response) {
  try {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const booking = req.body as BookingDraft;
    if (
      !booking?.practitionerId ||
      !booking?.offeringId ||
      !booking?.sessionDate ||
      !booking?.sessionTime ||
      !Number.isFinite(Number(booking.durationMinutes)) ||
      Number(booking.durationMinutes) <= 0
    ) {
      return res.status(400).json({ error: "A valid free session booking is required" });
    }
    if (Number(booking.amountInr) !== 0) {
      return res.status(400).json({ error: "This endpoint only accepts zero-price offerings" });
    }

    const supabase = requireSupabaseAdmin();
    const { data: offering, error: offeringError } = await supabase
      .from("practitioner_offerings")
      .select("id, practitioner_id, duration_minutes, price, is_active")
      .eq("id", booking.offeringId)
      .maybeSingle();

    if (offeringError || !offering) {
      return res.status(404).json({ error: "Session offering not found" });
    }
    if (!offering.is_active || offering.practitioner_id !== booking.practitionerId) {
      return res.status(400).json({ error: "This session offering is no longer available" });
    }
    if (Number(offering.price) !== 0) {
      return res.status(400).json({ error: "This offering is not free" });
    }
    if (Number(offering.duration_minutes) !== Number(booking.durationMinutes)) {
      return res.status(400).json({ error: "Duration does not match the selected offering" });
    }

    const { data, error } = await supabase.rpc("create_free_practitioner_booking", {
      p_user_id: user.id,
      p_booking: { ...booking, amountInr: 0 },
    });
    if (error) {
      console.error("[bookingCheckout][server] free booking RPC failed", error.message);
      return res.status(500).json({ error: "Could not confirm free booking" });
    }

    const result = data as {
      ok?: boolean;
      error?: string;
      booking_id?: string;
      booking_number?: string;
    } | null;
    if (!result?.ok || !result.booking_id || !result.booking_number) {
      const conflict = result?.error?.toLowerCase().includes("already booked");
      return res.status(conflict ? 409 : 400).json({
        error: result?.error ?? "Could not confirm free booking",
      });
    }

    // Meet generation is best-effort: the confirmed booking is retained if Google is unavailable.
    await ensureBookingMeetLink(supabase, result.booking_id);

    const { data: savedBooking } = await supabase
      .from("practitioner_bookings")
      .select("meeting_link, meeting_creation_status")
      .eq("id", result.booking_id)
      .maybeSingle();

    return res.status(201).json({
      bookingId: result.booking_id,
      bookingNumber: result.booking_number,
      paymentStatus: "Free",
      meetingLink: savedBooking?.meeting_link ?? null,
      meetingCreationStatus: savedBooking?.meeting_creation_status ?? "retry",
    });
  } catch (err) {
    console.error("[bookingCheckout][server] free booking failed", err);
    return res.status(500).json({ error: "Could not confirm free booking" });
  }
}

export function registerBookingCheckoutRoutes(app: Express) {
  app.post("/api/bookings/checkout/create-order", handleCreateOrder);
  app.post("/api/bookings/checkout/confirm", handleConfirmPayment);
  app.post("/api/bookings/free", handleFreeBooking);
}
