import crypto from "node:crypto";

/**
 * RazorpayX payout API (server-only). No-op when credentials are missing.
 */

export type RazorpayPayoutResult =
  | { ok: true; payoutId: string; fundAccountId?: string; status: string }
  | { ok: false; error: string; skipped?: boolean };

function getAuthHeader(): string | null {
  const keyId = process.env.RAZORPAYX_KEY_ID ?? process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAYX_KEY_SECRET ?? process.env.RAZORPAY_KEY_SECRET;
  if (!keyId?.trim() || !keySecret?.trim()) return null;
  const token = Buffer.from(`${keyId.trim()}:${keySecret.trim()}`).toString("base64");
  return `Basic ${token}`;
}

export function isRazorpayConfigured(): boolean {
  return Boolean(getAuthHeader());
}

export async function createRazorpayPayout(params: {
  referenceId: string;
  amountInr: number;
  fundAccountId?: string;
  narration?: string;
}): Promise<RazorpayPayoutResult> {
  const auth = getAuthHeader();
  const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER?.trim();
  const fundAccountId =
    params.fundAccountId?.trim() ??
    process.env.RAZORPAYX_FUND_ACCOUNT_ID?.trim();

  if (!auth) {
    return { ok: false, error: "RazorpayX credentials not configured", skipped: true };
  }
  if (!accountNumber) {
    return { ok: false, error: "RAZORPAYX_ACCOUNT_NUMBER is not set" };
  }
  if (!fundAccountId) {
    return { ok: false, error: "RAZORPAYX_FUND_ACCOUNT_ID is not set" };
  }

  const amountPaise = Math.round(params.amountInr * 100);
  if (amountPaise < 100) {
    return { ok: false, error: "Payout amount below minimum (Rs. 1)" };
  }

  const body = {
    account_number: accountNumber,
    fund_account_id: fundAccountId,
    amount: amountPaise,
    currency: "INR",
    mode: process.env.RAZORPAYX_PAYOUT_MODE?.trim() || "IMPS",
    purpose: "payout",
    queue_if_low_balance: true,
    reference_id: params.referenceId,
    narration: params.narration ?? "Nature's Grace seller payout",
  };

  try {
    const res = await fetch("https://api.razorpay.com/v1/payouts", {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as {
      id?: string;
      status?: string;
      fund_account_id?: string;
      error?: { description?: string; reason?: string };
    };

    if (!res.ok) {
      const msg =
        json.error?.description ??
        json.error?.reason ??
        `RazorpayX HTTP ${res.status}`;
      return { ok: false, error: msg };
    }

    if (!json.id) {
      return { ok: false, error: "RazorpayX returned no payout id" };
    }

    return {
      ok: true,
      payoutId: json.id,
      fundAccountId: json.fund_account_id ?? fundAccountId,
      status: json.status ?? "processing",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "RazorpayX request failed",
    };
  }
}

export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signature: string | undefined
): boolean {
  const secret = process.env.RAZORPAYX_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return false;
  }
  if (!signature) return false;

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return expected === signature;
  }
}
