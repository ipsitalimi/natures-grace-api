import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { fulfillStoreOrderPayment } from "./orderFulfillment";
import { fulfillBookingPayment } from "./bookingFulfillment";

export function verifyPaymentWebhookSignature(
  rawBody: Buffer | string,
  signature: string | undefined
): boolean {
  const secret =
    process.env.RAZORPAY_WEBHOOK_SECRET?.trim() ??
    process.env.RAZORPAYX_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return false;
  }
  if (!signature) return false;

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return expected === signature;
  }
}

async function resolveStoreOrderId(
  supabase: SupabaseClient,
  razorpayOrderId: string,
  notes?: Record<string, string>
): Promise<string | null> {
  const fromNotes = notes?.store_order_id;
  if (fromNotes) return fromNotes;

  const { data } = await supabase
    .from("orders")
    .select("id")
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();

  return (data as { id?: string } | null)?.id ?? null;
}

export async function handlePaymentCaptured(payload: {
  payment?: {
    entity?: {
      id?: string;
      order_id?: string;
      notes?: Record<string, string>;
    };
  };
}): Promise<{ matched: boolean; type?: string; id?: string }> {
  const entity = payload.payment?.entity;
  const paymentId = entity?.id;
  const razorpayOrderId = entity?.order_id;
  if (!paymentId || !razorpayOrderId) {
    return { matched: false };
  }

  const supabase = requireSupabaseAdmin();
  const notes = entity.notes ?? {};

  const storeOrderId = await resolveStoreOrderId(supabase, razorpayOrderId, notes);
  if (storeOrderId) {
    const { data: order } = await supabase
      .from("orders")
      .select("user_id")
      .eq("id", storeOrderId)
      .maybeSingle();

    if (order?.user_id) {
      const result = await fulfillStoreOrderPayment({
        supabase,
        storeOrderId,
        razorpayOrderId,
        paymentId,
      });
      if (result.ok) {
        return { matched: true, type: "store_order", id: storeOrderId };
      }
    }
  }

  const { data: pending } = await supabase
    .from("pending_booking_checkouts")
    .select("user_id, booking_draft")
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();

  if (pending?.user_id) {
    const result = await fulfillBookingPayment({
      supabase,
      userId: pending.user_id as string,
      razorpayOrderId,
      paymentId,
      booking: pending.booking_draft as Parameters<typeof fulfillBookingPayment>[0]["booking"],
    });
    if (result.ok) {
      return { matched: true, type: "booking", id: result.bookingId };
    }
  }

  return { matched: false };
}
