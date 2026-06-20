import crypto from "node:crypto";

export type CreateOrderResult =
  | {
      ok: true;
      orderId: string;
      amountPaise: number;
      currency: string;
      devMode?: boolean;
    }
  | { ok: false; error: string; devMode?: boolean };

export type ConfirmPaymentResult =
  | { ok: true; paymentId: string; orderId: string }
  | { ok: false; error: string };

function getAuthHeader(): string | null {
  const keyId = process.env.RAZORPAY_KEY_ID ?? process.env.RAZORPAYX_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? process.env.RAZORPAYX_KEY_SECRET;
  if (!keyId?.trim() || !keySecret?.trim()) return null;
  const token = Buffer.from(`${keyId.trim()}:${keySecret.trim()}`).toString("base64");
  return `Basic ${token}`;
}

export function isCheckoutConfigured(): boolean {
  return Boolean(getAuthHeader());
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function createBookingOrder(params: {
  amountInr: number;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<CreateOrderResult> {
  const auth = getAuthHeader();
  const amountPaise = Math.round(params.amountInr * 100);

  if (amountPaise < 100) {
    return { ok: false, error: "Amount below minimum (Rs. 1)" };
  }

  if (!auth) {
    if (isProduction()) {
      return { ok: false, error: "Razorpay is not configured" };
    }
    const orderId = `order_dev_${params.receipt}`;
    return {
      ok: true,
      orderId,
      amountPaise,
      currency: "INR",
      devMode: true,
    };
  }

  try {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: params.receipt.slice(0, 40),
        notes: params.notes ?? {},
      }),
    });

    const json = (await res.json()) as {
      id?: string;
      error?: { description?: string };
    };

    if (!res.ok || !json.id) {
      return {
        ok: false,
        error: json.error?.description ?? `Razorpay orders HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      orderId: json.id,
      amountPaise,
      currency: "INR",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Order creation failed",
    };
  }
}

export function verifyPaymentSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET ?? process.env.RAZORPAYX_KEY_SECRET;
  if (!secret?.trim()) return false;

  const body = `${params.orderId}|${params.paymentId}`;
  const expected = crypto
    .createHmac("sha256", secret.trim())
    .update(body)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(params.signature));
  } catch {
    return expected === params.signature;
  }
}

export async function confirmBookingPayment(params: {
  orderId: string;
  paymentId: string;
  signature?: string;
  devMode?: boolean;
}): Promise<ConfirmPaymentResult> {
  if (params.devMode || params.orderId.startsWith("order_dev_")) {
    if (isProduction()) {
      return { ok: false, error: "Dev payment mode is disabled in production" };
    }
    const paymentId = params.paymentId || `pay_dev_${Date.now()}`;
    return { ok: true, paymentId, orderId: params.orderId };
  }

  if (!params.paymentId) {
    return { ok: false, error: "paymentId is required" };
  }

  if (!params.signature || !verifyPaymentSignature(params as { orderId: string; paymentId: string; signature: string })) {
    return { ok: false, error: "Invalid payment signature" };
  }

  return { ok: true, paymentId: params.paymentId, orderId: params.orderId };
}
