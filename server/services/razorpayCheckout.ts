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
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
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
  const secret = process.env.RAZORPAY_KEY_SECRET;
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
  expectedAmountPaise?: number;
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

  const auth = getAuthHeader();
  if (!auth) return { ok: false, error: "Razorpay is not configured" };

  try {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(params.paymentId)}`, {
      headers: { Authorization: auth },
    });
    const payment = await response.json() as {
      id?: string; order_id?: string; amount?: number; currency?: string; status?: string;
      error?: { description?: string };
    };
    if (!response.ok) return { ok: false, error: payment.error?.description ?? "Unable to verify payment with Razorpay" };
    if (payment.order_id !== params.orderId) return { ok: false, error: "Payment does not belong to this order" };
    if (payment.status !== "captured") return { ok: false, error: "Payment has not been captured" };
    if (payment.currency !== "INR") return { ok: false, error: "Payment currency mismatch" };
    if (params.expectedAmountPaise != null && payment.amount !== params.expectedAmountPaise) {
      return { ok: false, error: "Paid amount does not match checkout total" };
    }
    return { ok: true, paymentId: params.paymentId, orderId: params.orderId };
  } catch {
    return { ok: false, error: "Could not verify payment with Razorpay" };
  }
}
