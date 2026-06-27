import {
  confirmBookingPayment,
  createBookingOrder,
  isCheckoutConfigured,
} from "./razorpayCheckout";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { fulfillStoreOrderPayment } from "./orderFulfillment";
import { validatePendingStoreOrderTotal } from "./storeOrderCreation";

export async function createStoreRazorpayOrder(params: {
  storeOrderId: string;
  userId: string;
}): Promise<
  | {
      ok: true;
      razorpayOrderId: string;
      amountPaise: number;
      amountInr: number;
      currency: string;
      keyId: string | null;
      devMode: boolean;
    }
  | { ok: false; error: string }
> {
  const supabase = requireSupabaseAdmin();

  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("id, user_id, payment_status, total")
    .eq("id", params.storeOrderId)
    .maybeSingle();

  if (fetchError || !order) {
    return { ok: false, error: "Store order not found" };
  }

  if (order.user_id !== params.userId) {
    return { ok: false, error: "Order does not belong to this account" };
  }

  if (order.payment_status !== "Pending") {
    return { ok: false, error: "Order is not awaiting payment" };
  }

  const validated = await validatePendingStoreOrderTotal(supabase, params.storeOrderId);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const amountInr = validated.amountInr;

  const result = await createBookingOrder({
    amountInr,
    receipt: params.storeOrderId.replace(/-/g, "").slice(0, 40),
    notes: { store_order_id: params.storeOrderId },
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  await supabase
    .from("orders")
    .update({ razorpay_order_id: result.orderId })
    .eq("id", params.storeOrderId)
    .eq("payment_status", "Pending");

  const keyId =
    process.env.RAZORPAY_KEY_ID?.trim() ??
    process.env.RAZORPAYX_KEY_ID?.trim() ??
    null;

  return {
    ok: true,
    razorpayOrderId: result.orderId,
    amountPaise: result.amountPaise,
    amountInr,
    currency: result.currency,
    keyId,
    devMode: result.devMode ?? false,
  };
}

export async function confirmStoreOrderPayment(params: {
  storeOrderId: string;
  userId: string;
  razorpayOrderId: string;
  paymentId: string;
  signature?: string;
  devMode?: boolean;
}): Promise<
  | { ok: true; paymentId: string; orderNumber: string }
  | { ok: false; error: string }
> {
  const supabase = requireSupabaseAdmin();

  const { data: existing, error: fetchError } = await supabase
    .from("orders")
    .select("id, user_id, payment_status, order_number")
    .eq("id", params.storeOrderId)
    .maybeSingle();

  if (fetchError || !existing) {
    return { ok: false, error: "Store order not found" };
  }

  if (existing.user_id !== params.userId) {
    return { ok: false, error: "Order does not belong to this account" };
  }

  const verified = await confirmBookingPayment({
    orderId: params.razorpayOrderId,
    paymentId: params.paymentId,
    signature: params.signature,
    devMode: params.devMode,
  });

  if (!verified.ok) {
    return { ok: false, error: verified.error };
  }

  if (existing.payment_status === "Paid") {
    return {
      ok: true,
      paymentId: verified.paymentId,
      orderNumber: existing.order_number as string,
    };
  }

  const fulfilled = await fulfillStoreOrderPayment({
    supabase,
    storeOrderId: params.storeOrderId,
    razorpayOrderId: params.razorpayOrderId,
    paymentId: verified.paymentId,
  });

  if (!fulfilled.ok) {
    return { ok: false, error: fulfilled.error };
  }

  return {
    ok: true,
    paymentId: verified.paymentId,
    orderNumber: fulfilled.orderNumber,
  };
}

export function storeCheckoutConfigured(): boolean {
  return isCheckoutConfigured();
}
