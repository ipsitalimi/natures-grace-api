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
} from "../services/bookingFulfillment";
import { fetchCommissionRate } from "../services/platformSettings";

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
    if (!user) return;

    const body = req.body as {
      practitionerId?: string;
      durationMinutes?: number;
      amountInr?: number;
      offeringId?: string;
      receipt?: string;
      booking?: BookingDraft;
    };

    if (!body.practitionerId || !body.durationMinutes || !body.amountInr) {
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

    const result = await createBookingOrder({
      amountInr: validated.amountInr,
      receipt: body.receipt ?? `bk_${user.id.slice(0, 8)}_${Date.now()}`,
      notes: {
        practitioner_id: body.practitionerId,
        user_id: user.id,
      },
    });

    if (!result.ok) {
      return res.status(502).json({ error: result.error });
    }

    if (body.booking) {
      const supabase = requireSupabaseAdmin();
      await savePendingBookingCheckout(
        supabase,
        user.id,
        result.orderId,
        { ...body.booking, amountInr: validated.amountInr }
      );
    }

    const keyId =
      process.env.RAZORPAY_KEY_ID?.trim() ??
      process.env.RAZORPAYX_KEY_ID?.trim() ??
      null;

    return res.json({
      orderId: result.orderId,
      amountPaise: result.amountPaise,
      amountInr: validated.amountInr,
      currency: result.currency,
      devMode: result.devMode ?? false,
      keyId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Create order failed";
    return res.status(500).json({ error: message });
  }
}

/** POST /api/bookings/checkout/confirm */
async function handleConfirmPayment(req: Request, res: Response) {
  try {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const { orderId, paymentId, signature, devMode, booking } = req.body as {
      orderId?: string;
      paymentId?: string;
      signature?: string;
      devMode?: boolean;
      booking?: BookingDraft;
    };

    if (!orderId || !booking) {
      return res.status(400).json({ error: "orderId and booking are required" });
    }

    const validated = await validateBookingAmount(
      booking.practitionerId,
      Number(booking.durationMinutes),
      Number(booking.amountInr),
      booking.offeringId
    );

    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }

    const verified = await confirmBookingPayment({
      orderId,
      paymentId: paymentId ?? "",
      signature,
      devMode,
    });

    if (!verified.ok) {
      return res.status(400).json({ error: verified.error });
    }

    const supabase = requireSupabaseAdmin();
    const commissionRate = await fetchCommissionRate(supabase);

    const created = await fulfillBookingPayment({
      supabase,
      userId: user.id,
      razorpayOrderId: orderId,
      paymentId: verified.paymentId,
      booking: { ...booking, amountInr: validated.amountInr },
      commissionRate,
    });

    if (!created.ok) {
      return res.status(500).json({ error: created.error });
    }

    return res.json({
      paymentId: verified.paymentId,
      orderId: verified.orderId,
      bookingId: created.bookingId,
      bookingNumber: created.bookingNumber,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Confirm failed";
    return res.status(500).json({ error: message });
  }
}

export function registerBookingCheckoutRoutes(app: Express) {
  app.post("/api/bookings/checkout/create-order", handleCreateOrder);
  app.post("/api/bookings/checkout/confirm", handleConfirmPayment);
}
