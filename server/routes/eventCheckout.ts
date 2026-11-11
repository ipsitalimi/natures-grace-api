import type { Express, Request, Response } from "express";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireBearerUser } from "../middleware/auth";
import {
  confirmBookingPayment,
  createBookingOrder,
} from "../services/razorpayCheckout";

function parseEventPrice(priceLabel: unknown): number | null {
  if (typeof priceLabel !== "string") return null;
  const normalized = priceLabel.trim();
  if (!normalized || /^free$/i.test(normalized)) return 0;
  const match = normalized.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

async function handleCreateEventOrder(req: Request, res: Response) {
  try {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const body = req.body as {
      eventId?: string;
      attendeeName?: string;
      attendeeEmail?: string;
      attendeePhone?: string;
      message?: string;
    };
    if (!body.eventId || !body.attendeeName?.trim() || !body.attendeeEmail?.trim() || !body.attendeePhone?.trim()) {
      return res.status(400).json({ error: "eventId, attendeeName, attendeeEmail, and attendeePhone are required" });
    }

    const supabase = requireSupabaseAdmin();
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, title, price_label, status, is_visible")
      .eq("id", body.eventId)
      .maybeSingle();

    if (eventError || !event) return res.status(404).json({ error: "Event not found" });
    if (event.status !== "Active" || event.is_visible !== true) {
      return res.status(409).json({ error: "This event is not accepting registrations" });
    }

    const amountInr = parseEventPrice(event.price_label);
    if (amountInr === null) return res.status(400).json({ error: "Event price is invalid. Ask the admin to update it." });
    if (amountInr === 0) return res.status(400).json({ error: "This is a free event. Use the free registration flow." });
    if (amountInr < 1) return res.status(400).json({ error: "Event price must be at least ₹1." });

    const { data: existing, error: existingError } = await supabase
      .from("event_registrations")
      .select("id, payment_status, razorpay_order_id, checkout_amount")
      .eq("event_id", body.eventId)
      .eq("user_id", user.id)
      .eq("status", "Registered")
      .maybeSingle();

    if (existingError) return res.status(500).json({ error: existingError.message });
    if (existing?.payment_status === "Paid") {
      return res.status(409).json({ error: "You are already registered and paid for this event." });
    }
    if (existing?.payment_status === "Pending" && existing.razorpay_order_id) {
      return res.json({
        orderId: existing.razorpay_order_id,
        amountPaise: Math.round(Number(existing.checkout_amount) * 100),
        amountInr: Number(existing.checkout_amount),
        currency: "INR",
        keyId: process.env.RAZORPAY_KEY_ID?.trim() ?? null,
        devMode: String(existing.razorpay_order_id).startsWith("order_dev_"),
      });
    }

    const order = await createBookingOrder({
      amountInr,
      receipt: `evt_${body.eventId.slice(0, 8)}_${user.id.slice(0, 8)}_${Date.now()}`,
      notes: { event_id: body.eventId, user_id: user.id },
    });
    if (!order.ok) return res.status(502).json({ error: order.error });

    const registrationPayload = {
      event_id: body.eventId,
      user_id: user.id,
      attendee_name: body.attendeeName.trim().slice(0, 160),
      attendee_email: body.attendeeEmail.trim().slice(0, 254),
      attendee_phone: body.attendeePhone.trim().slice(0, 40),
      message: body.message?.trim().slice(0, 2000) ?? "",
      status: "Registered",
      payment_status: "Pending",
      razorpay_order_id: order.orderId,
      checkout_amount: amountInr,
    };

    if (existing?.id) {
      const { data: updated, error: updateError } = await supabase
        .from("event_registrations")
        .update(registrationPayload)
        .eq("id", existing.id)
        .eq("payment_status", "None")
        .select("id")
        .maybeSingle();
      if (updateError || !updated) return res.status(409).json({ error: "An active registration already exists. Refresh and try again." });
    } else {
      const { error: insertError } = await supabase
        .from("event_registrations")
        .insert(registrationPayload);
      if (insertError) {
        if (insertError.code === "23505") {
          return res.status(409).json({ error: "An active registration already exists. Refresh and try again." });
        }
        return res.status(500).json({ error: insertError.message });
      }
    }

    return res.json({
      orderId: order.orderId,
      amountPaise: order.amountPaise,
      amountInr,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID?.trim() ?? null,
      devMode: order.devMode ?? false,
    });
  } catch (err) {
    console.error("[eventCheckout] create order failed", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Could not create event checkout" });
  }
}

async function handleConfirmEventPayment(req: Request, res: Response) {
  try {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const { orderId, paymentId, signature, devMode } = req.body as {
      orderId?: string;
      paymentId?: string;
      signature?: string;
      devMode?: boolean;
    };
    if (!orderId) return res.status(400).json({ error: "orderId is required" });

    const supabase = requireSupabaseAdmin();
    const { data: registration, error: lookupError } = await supabase
      .from("event_registrations")
      .select("id, user_id, payment_status, checkout_amount, razorpay_payment_id")
      .eq("razorpay_order_id", orderId)
      .maybeSingle();

    if (lookupError || !registration || registration.user_id !== user.id) {
      return res.status(404).json({ error: "Event checkout not found for this account" });
    }
    if (registration.payment_status === "Paid") {
      if (registration.razorpay_payment_id === paymentId) {
        return res.json({ paymentId, orderId, registrationId: registration.id });
      }
      return res.status(409).json({ error: "This event registration has already been paid." });
    }
    if (registration.payment_status !== "Pending" || !registration.checkout_amount) {
      return res.status(409).json({ error: "Event checkout is not pending payment" });
    }

    const expectedAmountPaise = Math.round(Number(registration.checkout_amount) * 100);
    const verified = await confirmBookingPayment({
      orderId,
      paymentId: paymentId ?? "",
      signature,
      devMode,
      expectedAmountPaise,
    });
    if (!verified.ok) return res.status(400).json({ error: verified.error });

    const { data: updated, error: updateError } = await supabase
      .from("event_registrations")
      .update({
        payment_status: "Paid",
        razorpay_payment_id: verified.paymentId,
        amount_paid: Number(registration.checkout_amount),
      })
      .eq("id", registration.id)
      .eq("payment_status", "Pending")
      .select("id")
      .maybeSingle();

    if (updateError) return res.status(500).json({ error: updateError.message });
    if (!updated) {
      const { data: current } = await supabase
        .from("event_registrations")
        .select("payment_status, razorpay_payment_id")
        .eq("id", registration.id)
        .maybeSingle();
      if (current?.payment_status !== "Paid" || current.razorpay_payment_id !== verified.paymentId) {
        return res.status(409).json({ error: "Payment confirmation is being processed. Refresh your registrations." });
      }
    }

    return res.json({ paymentId: verified.paymentId, orderId, registrationId: registration.id });
  } catch (err) {
    console.error("[eventCheckout] confirmation failed", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Could not confirm event payment" });
  }
}

export function registerEventCheckoutRoutes(app: Express) {
  app.post("/api/events/checkout/create-order", handleCreateEventOrder);
  app.post("/api/events/checkout/confirm", handleConfirmEventPayment);
}
