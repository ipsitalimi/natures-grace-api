import crypto from "node:crypto";

function getAuthHeader(): string | null {
  const keyId = process.env.RAZORPAY_KEY_ID ?? process.env.RAZORPAYX_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? process.env.RAZORPAYX_KEY_SECRET;
  if (!keyId?.trim() || !keySecret?.trim()) return null;
  const token = Buffer.from(`${keyId.trim()}:${keySecret.trim()}`).toString("base64");
  return `Basic ${token}`;
}

export async function createRazorpayRefund(params: {
  paymentId: string;
  amountInr?: number;
  notes?: Record<string, string>;
}): Promise<{ ok: true; refundId: string } | { ok: false; error: string }> {
  const auth = getAuthHeader();
  if (!auth) {
    return { ok: false, error: "Razorpay is not configured" };
  }

  const body: Record<string, unknown> = {
    notes: params.notes ?? {},
  };
  if (params.amountInr !== undefined) {
    body.amount = Math.round(params.amountInr * 100);
  }

  try {
    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(params.paymentId)}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const json = (await res.json()) as { id?: string; error?: { description?: string } };
    if (!res.ok || !json.id) {
      return {
        ok: false,
        error: json.error?.description ?? `Razorpay refund HTTP ${res.status}`,
      };
    }

    return { ok: true, refundId: json.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Refund request failed",
    };
  }
}
