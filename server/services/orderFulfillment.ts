import type { SupabaseClient } from "@supabase/supabase-js";
import { creditOrderEarning } from "./sellerWalletLedger";
import { dispatchUserNotification } from "./notificationDispatch";
import { fetchCommissionRate } from "./platformSettings";

type StoreOrderRow = {
  id: string;
  order_number: string;
  user_id: string;
  payment_status: string;
  status: string;
  seller_id: string | null;
  total: number;
  seller_promo_id?: string | null;
  platform_promo_id?: string | null;
};

async function decrementOrderStock(
  supabase: SupabaseClient,
  orderId: string
): Promise<void> {
  const { data: items } = await supabase
    .from("order_items")
    .select("product_id, quantity")
    .eq("order_id", orderId);

  for (const item of items ?? []) {
    const productId = (item as { product_id: string }).product_id;
    const qty = Number((item as { quantity: number }).quantity) || 0;
    if (!productId || qty <= 0) continue;

    const { data: product } = await supabase
      .from("products")
      .select("stock")
      .eq("id", productId)
      .maybeSingle();

    if (!product) continue;
    const nextStock = Math.max(0, Number(product.stock) - qty);
    await supabase.from("products").update({ stock: nextStock }).eq("id", productId);
  }
}

/** Restore product stock when an order refund is approved. */
export async function restoreOrderStock(
  supabase: SupabaseClient,
  orderId: string
): Promise<void> {
  const { data: items } = await supabase
    .from("order_items")
    .select("product_id, quantity")
    .eq("order_id", orderId);

  for (const item of items ?? []) {
    const productId = (item as { product_id: string }).product_id;
    const qty = Number((item as { quantity: number }).quantity) || 0;
    if (!productId || qty <= 0) continue;

    const { data: product } = await supabase
      .from("products")
      .select("stock")
      .eq("id", productId)
      .maybeSingle();

    if (!product) continue;
    const nextStock = Number(product.stock) + qty;
    await supabase.from("products").update({ stock: nextStock }).eq("id", productId);
  }
}

async function adjustPromoUsage(
  supabase: SupabaseClient,
  promoId: string,
  table: "seller_promos" | "platform_promo_codes",
  delta: number
): Promise<void> {
  const { data: promoRow } = await supabase
    .from(table)
    .select("usage_count")
    .eq("id", promoId)
    .maybeSingle();
  const current = promoRow?.usage_count;
  if (typeof current === "number") {
    await supabase
      .from(table)
      .update({ usage_count: Math.max(0, current + delta) })
      .eq("id", promoId);
  }
}

/** Decrement promo usage counters after a refunded order. */
export async function restorePromoUsageOnRefund(
  supabase: SupabaseClient,
  order: Pick<StoreOrderRow, "seller_promo_id" | "platform_promo_id">
): Promise<void> {
  if (order.seller_promo_id) {
    await adjustPromoUsage(supabase, order.seller_promo_id, "seller_promos", -1);
  }
  if (order.platform_promo_id) {
    await adjustPromoUsage(supabase, order.platform_promo_id, "platform_promo_codes", -1);
  }
}

async function incrementPromoUsage(
  supabase: SupabaseClient,
  order: StoreOrderRow
): Promise<void> {
  const promoId = order.seller_promo_id;
  if (promoId) {
    const { data: promoRow } = await supabase
      .from("seller_promos")
      .select("usage_count")
      .eq("id", promoId)
      .maybeSingle();
    const current = promoRow?.usage_count;
    if (typeof current === "number") {
      await supabase
        .from("seller_promos")
        .update({ usage_count: current + 1 })
        .eq("id", promoId);
    }
  }

  const platId = order.platform_promo_id;
  if (platId) {
    const { data: platRow } = await supabase
      .from("platform_promo_codes")
      .select("usage_count")
      .eq("id", platId)
      .maybeSingle();
    const pcur = platRow?.usage_count;
    if (typeof pcur === "number") {
      await supabase
        .from("platform_promo_codes")
        .update({ usage_count: pcur + 1 })
        .eq("id", platId);
    }
  }
}

async function notifySellerNewOrder(
  supabase: SupabaseClient,
  order: StoreOrderRow
): Promise<void> {
  if (!order.seller_id) return;

  const { data: seller } = await supabase
    .from("sellers")
    .select("profile_id")
    .eq("id", order.seller_id)
    .maybeSingle();

  const profileId = (seller as { profile_id?: string } | null)?.profile_id;
  if (!profileId) return;

  await dispatchUserNotification(supabase, {
    userId: profileId,
    event: "order_confirmed",
    message: `New paid order ${order.order_number} received.`,
    linkRoute: "SellerMain",
  });
}

/** Idempotent: mark store order paid, credit seller, decrement stock, notify parties. */
export async function fulfillStoreOrderPayment(params: {
  supabase: SupabaseClient;
  storeOrderId: string;
  razorpayOrderId: string;
  paymentId: string;
  commissionRate?: number;
}): Promise<{ ok: true; orderNumber: string; alreadyPaid: boolean } | { ok: false; error: string }> {
  const { supabase, storeOrderId, razorpayOrderId, paymentId } = params;

  const { data: existing, error: fetchError } = await supabase
    .from("orders")
    .select(
      "id, order_number, user_id, payment_status, status, seller_id, total, seller_promo_id, platform_promo_id"
    )
    .eq("id", storeOrderId)
    .maybeSingle();

  if (fetchError || !existing) {
    return { ok: false, error: "Store order not found" };
  }

  const order = existing as StoreOrderRow;

  if (order.payment_status === "Paid") {
    return { ok: true, orderNumber: order.order_number as string, alreadyPaid: true };
  }

  if (order.payment_status !== "Pending") {
    return { ok: false, error: "Order is not awaiting payment" };
  }

  const { error: updateError } = await supabase
    .from("orders")
    .update({
      payment_status: "Paid",
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
    })
    .eq("id", storeOrderId)
    .eq("payment_status", "Pending");

  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  const commissionRate =
    params.commissionRate ?? (await fetchCommissionRate(supabase));

  await incrementPromoUsage(supabase, order);
  await decrementOrderStock(supabase, storeOrderId);

  await creditOrderEarning(
    supabase,
    {
      id: order.id,
      order_number: order.order_number,
      seller_id: order.seller_id,
      status: order.status,
      payment_status: "Paid",
      total: Number(order.total),
    },
    commissionRate
  );

  await dispatchUserNotification(supabase, {
    userId: order.user_id,
    event: "order_confirmed",
    message: `Order ${order.order_number} confirmed. Payment received.`,
    linkRoute: "OrderDetail",
    linkTargetId: order.id,
    emailVars: {
      orderNumber: order.order_number as string,
      total: `₹${Number(order.total).toLocaleString("en-IN")}`,
    },
  });

  await notifySellerNewOrder(supabase, order);

  return { ok: true, orderNumber: order.order_number as string, alreadyPaid: false };
}
