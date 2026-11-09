import type { SupabaseClient } from "@supabase/supabase-js";
import { isBankAccountLinkedForPayout, validateBankDetailsInput } from "../lib/walletBank";

type BookingRow = {
  id: string;
  booking_number: string;
  practitioner_id: string | null;
  booking_status: string;
  payment_status: string;
  amount: number;
  service_name: string;
  razorpay_payment_id?: string | null;
};

function isVerifiedBookingPaymentId(paymentId: string | null | undefined): boolean {
  const id = paymentId?.trim();
  if (!id) return false;
  if (process.env.NODE_ENV === "production" && id.startsWith("pay_dev_")) {
    return false;
  }
  return true;
}

type WalletRow = {
  id: string;
  practitioner_id: string | null;
  available_balance: number;
  pending_payout: number;
  held_balance: number;
  total_earned: number;
  commission_rate: number;
  bank_account_label?: string | null;
};

type WalletTxnRow = {
  id: string;
  amount: number;
  is_released: boolean;
};

function netEarning(gross: number, commissionRate: number): number {
  return Math.round(gross * (1 - commissionRate / 100) * 100) / 100;
}

async function getOrCreatePractitionerWallet(
  supabase: SupabaseClient,
  practitionerId: string,
  commissionRate: number
): Promise<WalletRow | null> {
  const { data: existing } = await supabase
    .from("practitioner_wallets")
    .select("*")
    .eq("practitioner_id", practitionerId)
    .maybeSingle();

  if (existing) return existing as WalletRow;

  const { data, error } = await supabase
    .from("practitioner_wallets")
    .insert({
      practitioner_id: practitionerId,
      commission_rate: commissionRate,
      bank_account_label: null,
      next_payout_date: null,
    })
    .select()
    .single();

  if (error || !data) return null;
  return data as WalletRow;
}

async function updateWallet(
  supabase: SupabaseClient,
  walletId: string,
  patch: Partial<WalletRow>
): Promise<void> {
  await supabase.from("practitioner_wallets").update(patch).eq("id", walletId);
}

async function hasTxn(
  supabase: SupabaseClient,
  walletId: string,
  bookingId: string,
  category: string
): Promise<boolean> {
  const { data } = await supabase
    .from("practitioner_wallet_transactions")
    .select("id")
    .eq("wallet_id", walletId)
    .eq("booking_id", bookingId)
    .eq("category", category)
    .maybeSingle();
  return Boolean(data);
}

export async function creditBookingEarning(
  supabase: SupabaseClient,
  booking: BookingRow,
  commissionRate: number
): Promise<void> {
  if (
    booking.payment_status !== "Paid" ||
    !booking.practitioner_id ||
    !isVerifiedBookingPaymentId(booking.razorpay_payment_id)
  ) {
    return;
  }

  const { data, error } = await supabase.rpc("credit_practitioner_booking_earning", {
    p_booking_id: booking.id,
    p_commission_rate: commissionRate,
  });
  if (error) throw new Error(`Practitioner earning credit failed: ${error.message}`);
  const result = data as { ok?: boolean; error?: string } | null;
  if (!result?.ok) throw new Error(result?.error ?? "Practitioner earning credit failed");

  if (booking.booking_status === "Completed") {
    await releaseBookingEarning(supabase, booking, commissionRate);
  }
}

export async function releaseBookingEarning(
  supabase: SupabaseClient, booking: BookingRow, commissionRate: number
): Promise<void> {
  if (booking.payment_status !== "Paid" || booking.booking_status !== "Completed" || !booking.practitioner_id) return;
  const wallet = await getOrCreatePractitionerWallet(supabase, booking.practitioner_id, commissionRate);
  if (!wallet) return;
  const { data: earning } = await supabase.from("practitioner_wallet_transactions").select("id")
    .eq("wallet_id", wallet.id).eq("booking_id", booking.id).eq("category", "booking_earning").maybeSingle();
  if (!earning) await creditBookingEarning(supabase, booking, commissionRate);
  const { data, error } = await supabase.rpc("release_wallet_earning", {
    p_wallet_type: "practitioner", p_wallet_id: wallet.id, p_order_or_booking_id: booking.id,
    p_description: `Released — ${booking.booking_number}`,
  });
  if (error) throw new Error(`Practitioner earning release failed: ${error.message}`);
  const result = data as { ok?: boolean; error?: string } | null;
  if (!result?.ok) throw new Error(result?.error ?? "Practitioner earning release failed");
}

export async function reverseBookingEarning(
  supabase: SupabaseClient, booking: BookingRow, commissionRate: number
): Promise<void> {
  if (!booking.practitioner_id) return;
  const wallet = await getOrCreatePractitionerWallet(supabase, booking.practitioner_id, commissionRate);
  if (!wallet) return;
  const { data, error } = await supabase.rpc("reverse_wallet_earning", {
    p_wallet_type: "practitioner", p_wallet_id: wallet.id, p_order_or_booking_id: booking.id,
    p_description: `Reversal — ${booking.booking_number}`,
  });
  if (error) throw new Error(`Practitioner earning reversal failed: ${error.message}`);
  const result = data as { ok?: boolean; error?: string } | null;
  if (!result?.ok) throw new Error(result?.error ?? "Practitioner earning reversal failed");
}

/**
 * Apply a proportional practitioner wallet reversal through a database RPC.
 * The SQL function locks the wallet and applies the ledger row + balance update
 * in one transaction, so retries cannot leave an inserted ledger entry without
 * its corresponding wallet adjustment.
 */
export async function reverseBookingEarningForRefund(
  supabase: SupabaseClient,
  booking: BookingRow,
  refundRequestId: string,
  refundAmountInr: number,
  customerTotalPaidInr: number,
  _commissionRate: number
): Promise<{ reversedAmount: number; error?: string }> {
  if (!booking.practitioner_id) return { reversedAmount: 0 };

  const refundAmount = Math.round(Number(refundAmountInr) * 100) / 100;
  const customerTotalPaid = Math.round(Number(customerTotalPaidInr) * 100) / 100;
  if (!Number.isFinite(refundAmount) || refundAmount <= 0 || customerTotalPaid <= 0) {
    return { reversedAmount: 0, error: "Invalid refund or booking amount" };
  }
  if (refundAmount > customerTotalPaid) {
    return { reversedAmount: 0, error: "Refund exceeds customer payment" };
  }

  const { data, error } = await supabase.rpc("apply_practitioner_booking_refund", {
    p_refund_request_id: refundRequestId,
    p_booking_id: booking.id,
    p_refund_amount_inr: refundAmount,
    p_customer_total_paid_inr: customerTotalPaid,
  });

  if (error) return { reversedAmount: 0, error: error.message };

  const result = data as {
    ok?: boolean;
    error?: string;
    reversed_amount?: number | string;
  } | null;

  if (!result?.ok) {
    return { reversedAmount: 0, error: result?.error ?? "Wallet refund reversal failed" };
  }

  return { reversedAmount: Number(result.reversed_amount ?? 0) };
}

export async function syncPractitionerWalletFromBookings(
  supabase: SupabaseClient,
  practitionerId: string,
  commissionRate: number
): Promise<void> {
  const { data: bookings } = await supabase
    .from("practitioner_bookings")
    .select(
      "id, booking_number, practitioner_id, booking_status, payment_status, amount, service_name, razorpay_payment_id"
    )
    .eq("practitioner_id", practitionerId);

  for (const row of (bookings ?? []) as BookingRow[]) {
    if (row.payment_status === "Refunded") {
      await reverseBookingEarning(supabase, row, commissionRate);
      continue;
    }
    // A cancelled booking can have a partial or zero refund. Its refund ledger
    // entries are authoritative; do not reverse the entire earning here.
    if (row.booking_status === "Cancelled") continue;
    if (row.payment_status === "Paid" && isVerifiedBookingPaymentId(row.razorpay_payment_id)) {
      await creditBookingEarning(supabase, row, commissionRate);
      if (row.booking_status === "Completed") {
        await releaseBookingEarning(supabase, row, commissionRate);
      }
    }
  }
}

export async function updatePractitionerBankDetails(
  supabase: SupabaseClient,
  practitionerId: string,
  commissionRate: number,
  input: { bankName: string; last4: string; accountHolder: string }
): Promise<{ error?: string }> {
  const validated = validateBankDetailsInput(input);
  if (!validated.ok) return { error: validated.error };

  const wallet = await getOrCreatePractitionerWallet(supabase, practitionerId, commissionRate);
  if (!wallet) return { error: "Wallet not found" };

  const { error } = await supabase
    .from("practitioner_wallets")
    .update({ bank_account_label: validated.label })
    .eq("id", wallet.id);

  if (error) return { error: error.message };
  return {};
}

export async function requestPractitionerPayout(
  supabase: SupabaseClient,
  practitionerId: string,
  amount: number,
  commissionRate: number
): Promise<{ payoutId?: string; error?: string }> {
  const wallet = await getOrCreatePractitionerWallet(supabase, practitionerId, commissionRate);
  if (!wallet) return { error: "Wallet not found" };

  const { data: walletRow, error: walletError } = await supabase
    .from("practitioner_wallets")
    .select("bank_account_label")
    .eq("id", wallet.id)
    .maybeSingle();
  if (walletError) return { error: walletError.message };
  if (!isBankAccountLinkedForPayout((walletRow as { bank_account_label?: string | null } | null)?.bank_account_label)) {
    return { error: "Bank account details required before requesting a withdrawal" };
  }
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Invalid amount" };

  const { data, error } = await supabase.rpc("request_wallet_payout", {
    p_payout_type: "practitioner",
    p_wallet_id: wallet.id,
    p_amount: Math.round(amount * 100) / 100,
    p_notes: "Manual withdrawal — processed by Nature's Grace team within 3–7 business days",
  });
  if (error) return { error: error.message };
  const result = data as { ok?: boolean; error?: string; payout_id?: string } | null;
  if (!result?.ok || !result.payout_id) return { error: result?.error ?? "Could not create payout" };
  return { payoutId: result.payout_id };
}

export async function verifyPractitionerPayoutOwnership(
  supabase: SupabaseClient,
  payoutId: string,
  profileId: string
): Promise<boolean> {
  const { data: payout } = await supabase
    .from("practitioner_payouts")
    .select("wallet_id")
    .eq("id", payoutId)
    .maybeSingle();

  if (!payout?.wallet_id) return false;

  const { data: wallet } = await supabase
    .from("practitioner_wallets")
    .select("practitioner_id")
    .eq("id", payout.wallet_id)
    .maybeSingle();

  if (!wallet?.practitioner_id) return false;

  const { data: practitioner } = await supabase
    .from("practitioners")
    .select("profile_id")
    .eq("id", wallet.practitioner_id)
    .maybeSingle();

  return practitioner?.profile_id === profileId;
}

export async function resolvePractitionerIdForProfile(
  supabase: SupabaseClient,
  profileId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("practitioners")
    .select("id")
    .eq("profile_id", profileId)
    .maybeSingle();
  return data?.id ?? null;
}

export function calculateSessionPrice(
  pricePerSession: number,
  durationMinutes: number
): number {
  const pricePerMinute = pricePerSession / 60;
  return Math.round(pricePerMinute * durationMinutes);
}

export async function createPaidBooking(
  supabase: SupabaseClient,
  input: {
    practitionerId: string;
    offeringId?: string;
    userId: string;
    clientName: string;
    clientEmail?: string;
    serviceName: string;
    sessionDate: string;
    sessionTime: string;
    durationMinutes: number;
    amount: number;
    platformFeeInr?: number;
    platformGstInr?: number;
    totalPaidAmountInr?: number;
    razorpayPaymentId: string;
    notes?: string;
  }
): Promise<{ bookingId: string; bookingNumber: string } | { error: string }> {
  const bookingNumber = `BK-${Date.now().toString(36).toUpperCase()}`;

  const { data: practitioner } = await supabase
    .from("practitioners")
    .select("meeting_link")
    .eq("id", input.practitionerId)
    .maybeSingle();

  const { data, error } = await supabase
    .from("practitioner_bookings")
    .insert({
      booking_number: bookingNumber,
      practitioner_id: input.practitionerId,
      offering_id: input.offeringId ?? null,
      user_id: input.userId,
      client_name: input.clientName,
      client_email: input.clientEmail ?? null,
      service_name: input.serviceName,
      session_date: input.sessionDate,
      session_time: input.sessionTime,
      duration_minutes: input.durationMinutes,
      amount: input.amount,
      platform_fee_inr: input.platformFeeInr ?? 0,
      platform_gst_inr: input.platformGstInr ?? 0,
      total_paid_amount_inr: input.totalPaidAmountInr ?? input.amount,
      booking_status: "Confirmed",
      payment_status: "Paid",
      razorpay_payment_id: input.razorpayPaymentId,
      notes: input.notes ?? null,
      meeting_link: (practitioner as { meeting_link?: string | null } | null)?.meeting_link ?? null,
    })
    .select("id, booking_number, practitioner_id, booking_status, payment_status, amount, service_name")
    .single();

  if (error || !data) {
    return { error: error?.message ?? "Could not create booking" };
  }

  return { bookingId: data.id as string, bookingNumber: data.booking_number as string };
}
