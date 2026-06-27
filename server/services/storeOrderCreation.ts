import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";

export type CreateStoreOrderItemInput = {
  productId: string;
  quantity: number;
};

export type CreateStoreOrderInput = {
  userId: string;
  customerName: string;
  customerEmail?: string;
  items: CreateStoreOrderItemInput[];
  deliveryOption?: string;
  notes?: string;
  sellerPromoId?: string | null;
  platformPromoId?: string | null;
};

type ProductRow = {
  id: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  seller_id: string | null;
  approval_status: string;
};

type DeliveryTierId = "standard" | "express" | "overnight";

type DeliverySettings = Record<DeliveryTierId, { enabled: boolean; price: number }>;

const DEFAULT_DELIVERY: DeliverySettings = {
  standard: { enabled: true, price: 0 },
  express: { enabled: false, price: 99 },
  overnight: { enabled: false, price: 199 },
};

function parseDeliverySettings(raw: unknown): DeliverySettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_DELIVERY };
  }
  const o = raw as Record<string, unknown>;
  const parseTier = (key: DeliveryTierId, fallback: { enabled: boolean; price: number }) => {
    const tier = o[key];
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
      return { ...fallback };
    }
    const t = tier as Record<string, unknown>;
    return {
      enabled: key === "standard" ? t.enabled !== false : t.enabled === true,
      price: Math.max(0, Number(t.price) || fallback.price),
    };
  };
  return {
    standard: parseTier("standard", DEFAULT_DELIVERY.standard),
    express: parseTier("express", DEFAULT_DELIVERY.express),
    overnight: parseTier("overnight", DEFAULT_DELIVERY.overnight),
  };
}

function deliveryFeeForOption(settings: DeliverySettings, optionId: string): number {
  const id = optionId as DeliveryTierId;
  if (id === "standard" || id === "express" || id === "overnight") {
    return settings[id].enabled ? settings[id].price : 0;
  }
  return settings.standard.enabled ? settings.standard.price : 0;
}

function computeSellerPromoDiscount(
  subtotal: number,
  row: {
    status: string;
    discount_type: string;
    discount_value: number;
    starts_at: string | null;
    expires_at: string | null;
    usage_limit: number | null;
    usage_count: number;
    min_order: number | null;
  }
): { ok: true; discount: number } | { ok: false; error: string } {
  if (row.status !== "Active") return { ok: false, error: "Promo is not active" };
  if (row.starts_at) {
    const st = new Date(row.starts_at);
    if (!Number.isNaN(st.getTime()) && st.getTime() > Date.now()) {
      return { ok: false, error: "Promo is not valid yet" };
    }
  }
  if (row.expires_at) {
    const ex = new Date(row.expires_at);
    if (!Number.isNaN(ex.getTime()) && ex.getTime() < Date.now()) {
      return { ok: false, error: "Promo has expired" };
    }
  }
  if (row.usage_limit != null && row.usage_count >= row.usage_limit) {
    return { ok: false, error: "Promo usage limit reached" };
  }
  if (row.min_order != null && subtotal < Number(row.min_order)) {
    return { ok: false, error: "Order does not meet promo minimum" };
  }
  const discount =
    row.discount_type === "percentage"
      ? Math.min(subtotal, Math.round((subtotal * Number(row.discount_value)) / 100))
      : Math.min(subtotal, Number(row.discount_value));
  if (discount <= 0) return { ok: false, error: "No discount applies" };
  return { ok: true, discount };
}

function computePlatformPromoDiscount(
  subtotal: number,
  row: {
    status: string;
    discount_type: string;
    discount_value: number;
    starts_at: string | null;
    expires_at: string | null;
    usage_limit: number | null;
    usage_count: number;
    min_order: number | null;
  }
): { ok: true; discount: number } | { ok: false; error: string } {
  return computeSellerPromoDiscount(subtotal, row);
}

async function generateOrderNumber(supabase: SupabaseClient): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `#NG-${Math.floor(1000 + Math.random() * 9000)}`;
    const { data } = await supabase
      .from("orders")
      .select("id")
      .eq("order_number", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return `#NG-${Date.now().toString().slice(-8)}`;
}

export async function createValidatedStoreOrder(
  input: CreateStoreOrderInput
): Promise<
  | {
      ok: true;
      orderId: string;
      orderNumber: string;
      subtotal: number;
      deliveryFee: number;
      promoDiscount: number;
      total: number;
    }
  | { ok: false; error: string }
> {
  const supabase = requireSupabaseAdmin();

  if (!input.items.length) {
    return { ok: false, error: "Cart is empty" };
  }

  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, name, category, price, stock, seller_id, approval_status")
    .in("id", productIds);

  if (productsError || !products?.length) {
    return { ok: false, error: "Products not found" };
  }

  const productMap = new Map(
    (products as ProductRow[]).map((p) => [p.id, p])
  );

  const sellerIds = new Set<string>();
  let subtotal = 0;
  const resolvedItems: {
    productId: string;
    productName: string;
    productCategory: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[] = [];

  for (const item of input.items) {
    const qty = Math.floor(Number(item.quantity));
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: "Invalid quantity" };
    }

    const product = productMap.get(item.productId);
    if (!product) {
      return { ok: false, error: "A product in your cart is no longer available" };
    }
    if (product.approval_status !== "Approved") {
      return { ok: false, error: `${product.name} is not available for purchase` };
    }
    if (!product.seller_id) {
      return { ok: false, error: "Product seller not found" };
    }
    if (Number(product.stock) < qty) {
      return { ok: false, error: `${product.name} is out of stock` };
    }

    sellerIds.add(product.seller_id);
    const unitPrice = Number(product.price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return { ok: false, error: "Invalid product price" };
    }

    const lineTotal = unitPrice * qty;
    subtotal += lineTotal;
    resolvedItems.push({
      productId: product.id,
      productName: product.name,
      productCategory: product.category,
      quantity: qty,
      unitPrice,
      lineTotal,
    });
  }

  if (sellerIds.size !== 1) {
    return { ok: false, error: "Checkout must contain items from a single seller" };
  }

  const sellerId = [...sellerIds][0]!;

  const { data: sellerRow } = await supabase
    .from("sellers")
    .select("delivery_settings")
    .eq("id", sellerId)
    .maybeSingle();

  const deliverySettings = parseDeliverySettings(
    (sellerRow as { delivery_settings?: unknown } | null)?.delivery_settings
  );
  const deliveryOption = input.deliveryOption?.trim() || "standard";
  const deliveryFee = deliveryFeeForOption(deliverySettings, deliveryOption);

  let promoDiscount = 0;
  let sellerPromoId: string | null = null;
  let platformPromoId: string | null = null;

  if (input.sellerPromoId) {
    const { data: promo } = await supabase
      .from("seller_promos")
      .select("*")
      .eq("id", input.sellerPromoId)
      .eq("seller_id", sellerId)
      .maybeSingle();
    if (!promo) {
      return { ok: false, error: "Promo code is not valid" };
    }
    const validated = computeSellerPromoDiscount(subtotal, promo as never);
    if (!validated.ok) return { ok: false, error: validated.error };
    promoDiscount = validated.discount;
    sellerPromoId = input.sellerPromoId;
  } else if (input.platformPromoId) {
    const { data: promo } = await supabase
      .from("platform_promo_codes")
      .select("*")
      .eq("id", input.platformPromoId)
      .maybeSingle();
    if (!promo) {
      return { ok: false, error: "Promo code is not valid" };
    }
    const validated = computePlatformPromoDiscount(subtotal, promo as never);
    if (!validated.ok) return { ok: false, error: validated.error };
    promoDiscount = validated.discount;
    platformPromoId = input.platformPromoId;
  }

  const total = Math.max(0, subtotal - promoDiscount + deliveryFee);
  const orderNumber = await generateOrderNumber(supabase);

  const { data: orderRow, error: orderError } = await supabase
    .from("orders")
    .insert({
      order_number: orderNumber,
      seller_id: sellerId,
      user_id: input.userId,
      customer_name: input.customerName,
      customer_email: input.customerEmail ?? null,
      status: "Pending",
      payment_status: "Pending",
      delivery_status: "Pending",
      delivery_option: deliveryOption,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      notes: input.notes ?? null,
      promo_discount: promoDiscount,
      seller_promo_id: sellerPromoId,
      platform_promo_id: platformPromoId,
    })
    .select("id, order_number, total, subtotal, delivery_fee, promo_discount")
    .single();

  if (orderError || !orderRow) {
    return { ok: false, error: orderError?.message ?? "Could not create order" };
  }

  const itemRows = resolvedItems.map((item) => ({
    order_id: orderRow.id,
    product_id: item.productId,
    product_name: item.productName,
    product_category: item.productCategory,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    line_total: item.lineTotal,
  }));

  const { error: itemsError } = await supabase.from("order_items").insert(itemRows);
  if (itemsError) {
    await supabase.from("orders").delete().eq("id", orderRow.id);
    return { ok: false, error: itemsError.message };
  }

  return {
    ok: true,
    orderId: orderRow.id as string,
    orderNumber: orderRow.order_number as string,
    subtotal: Number(orderRow.subtotal),
    deliveryFee: Number(orderRow.delivery_fee),
    promoDiscount: Number(orderRow.promo_discount),
    total: Number(orderRow.total),
  };
}

/** Recompute authoritative total from DB product prices for an existing pending order. */
export async function validatePendingStoreOrderTotal(
  supabase: SupabaseClient,
  storeOrderId: string
): Promise<{ ok: true; amountInr: number } | { ok: false; error: string }> {
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, payment_status, seller_promo_id, platform_promo_id, delivery_option, seller_id")
    .eq("id", storeOrderId)
    .maybeSingle();

  if (orderError || !order) {
    return { ok: false, error: "Store order not found" };
  }

  if (order.payment_status !== "Pending") {
    return { ok: false, error: "Order is not awaiting payment" };
  }

  const { data: items } = await supabase
    .from("order_items")
    .select("product_id, quantity, unit_price")
    .eq("order_id", storeOrderId);

  if (!items?.length) {
    return { ok: false, error: "Order has no items" };
  }

  const productIds = items
    .map((i) => (i as { product_id: string | null }).product_id)
    .filter(Boolean) as string[];

  const { data: products } = await supabase
    .from("products")
    .select("id, price")
    .in("id", productIds);

  const priceMap = new Map(
    ((products ?? []) as { id: string; price: number }[]).map((p) => [p.id, Number(p.price)])
  );

  let subtotal = 0;
  for (const item of items) {
    const row = item as { product_id: string | null; quantity: number; unit_price: number };
    const dbPrice = row.product_id ? priceMap.get(row.product_id) : undefined;
    if (dbPrice == null) {
      return { ok: false, error: "Product price could not be verified" };
    }
    if (Math.abs(Number(row.unit_price) - dbPrice) > 0.01) {
      return { ok: false, error: "Order pricing is out of date. Please create a new order." };
    }
    subtotal += dbPrice * Number(row.quantity);
  }

  let promoDiscount = 0;
  if (order.seller_promo_id) {
    const { data: promo } = await supabase
      .from("seller_promos")
      .select("*")
      .eq("id", order.seller_promo_id)
      .maybeSingle();
    if (promo) {
      const v = computeSellerPromoDiscount(subtotal, promo as never);
      if (v.ok) promoDiscount = v.discount;
    }
  } else if (order.platform_promo_id) {
    const { data: promo } = await supabase
      .from("platform_promo_codes")
      .select("*")
      .eq("id", order.platform_promo_id)
      .maybeSingle();
    if (promo) {
      const v = computePlatformPromoDiscount(subtotal, promo as never);
      if (v.ok) promoDiscount = v.discount;
    }
  }

  const { data: sellerRow } = await supabase
    .from("sellers")
    .select("delivery_settings")
    .eq("id", order.seller_id)
    .maybeSingle();

  const deliverySettings = parseDeliverySettings(
    (sellerRow as { delivery_settings?: unknown } | null)?.delivery_settings
  );
  const deliveryFee = deliveryFeeForOption(
    deliverySettings,
    (order.delivery_option as string) || "standard"
  );

  const authoritativeTotal = Math.max(0, subtotal - promoDiscount + deliveryFee);

  const { error: patchError } = await supabase
    .from("orders")
    .update({
      subtotal,
      delivery_fee: deliveryFee,
      promo_discount: promoDiscount,
      total: authoritativeTotal,
    })
    .eq("id", storeOrderId)
    .eq("payment_status", "Pending");

  if (patchError) {
    return { ok: false, error: patchError.message };
  }

  return { ok: true, amountInr: authoritativeTotal };
}
