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

  const wallet = await getOrCreatePractitionerWallet(
    supabase,
    booking.practitioner_id,
    commissionRate
  );
  if (!wallet) return;

  if (await hasTxn(supabase, wallet.id, booking.id, "booking_earning")) return;

  const net = netEarning(Number(booking.amount), commissionRate);

  await supabase.from("practitioner_wallet_transactions").insert({
    wallet_id: wallet.id,
    booking_id: booking.id,
    type: "credit",
    category: "booking_earning",
    amount: net,
    description: `Session ${booking.booking_number} — ${booking.service_name}`,
    is_released: false,
  });

  await updateWallet(supabase, wallet.id, {
    total_earned: Number(wallet.total_earned) + net,
    held_balance: Number(wallet.held_balance) + net,
  });

  if (booking.booking_status === "Completed") {
    await releaseBookingEarning(supabase, booking, commissionRate);
  }
}

export async function releaseBookingEarning(
  supabase: SupabaseClient,
  booking: BookingRow,
  commissionRate: number
): Promise<void> {
  if (
    booking.payment_status !== "Paid" ||
    booking.booking_status !== "Completed" ||
    !booking.practitioner_id
  ) {
    return;
  }

  const wallet = await getOrCreatePractitionerWallet(
    supabase,
    booking.practitioner_id,
    commissionRate
  );
  if (!wallet) return;

  if (await hasTxn(supabase, wallet.id, booking.id, "earning_release")) return;

  const { data: earning } = await supabase
    .from("practitioner_wallet_transactions")
    .select("*")
    .eq("wallet_id", wallet.id)
    .eq("booking_id", booking.id)
    .eq("category", "booking_earning")
    .maybeSingle();

  if (!earning) {
    await creditBookingEarning(supabase, booking, commissionRate);
    return;
  }

  const row = earning as WalletTxnRow;
  if (row.is_released) return;

  const net = Number(row.amount);

  await supabase
    .from("practitioner_wallet_transactions")
    .update({ is_released: true })
    .eq("id", row.id);

  await supabase.from("practitioner_wallet_transactions").insert({
    wallet_id: wallet.id,
    booking_id: booking.id,
    type: "credit",
    category: "earning_release",
    amount: net,
    description: `Released — ${booking.booking_number}`,
    is_released: true,
  });

  const { data: fresh } = await supabase
    .from("practitioner_wallets")
    .select("*")
    .eq("id", wallet.id)
    .single();

  if (!fresh) return;

  const w = fresh as WalletRow;
  await updateWallet(supabase, w.id, {
    held_balance: Math.max(0, Number(w.held_balance) - net),
    available_balance: Number(w.available_balance) + net,
  });
}

export async function reverseBookingEarning(
  supabase: SupabaseClient,
  booking: BookingRow,
  commissionRate: number
): Promise<void> {
  if (!booking.practitioner_id) return;

  const wallet = await getOrCreatePractitionerWallet(
    supabase,
    booking.practitioner_id,
    commissionRate
  );
  if (!wallet) return;

  const { data: earning } = await supabase
    .from("practitioner_wallet_transactions")
    .select("*")
    .eq("wallet_id", wallet.id)
    .eq("booking_id", booking.id)
    .eq("category", "booking_earning")
    .maybeSingle();

  if (!earning) return;

  const row = earning as WalletTxnRow;
  const net = Number(row.amount);

  if (await hasTxn(supabase, wallet.id, booking.id, "refund")) return;

  await supabase.from("practitioner_wallet_transactions").insert({
    wallet_id: wallet.id,
    booking_id: booking.id,
    type: "debit",
    category: "refund",
    amount: net,
    description: `Reversal — ${booking.booking_number}`,
    is_released: true,
  });

  const { data: fresh } = await supabase
    .from("practitioner_wallets")
    .select("*")
    .eq("id", wallet.id)
    .single();

  if (!fresh) return;

  const w = fresh as WalletRow;
  const patch: Partial<WalletRow> = {
    total_earned: Math.max(0, Number(w.total_earned) - net),
  };

  if (row.is_released) {
    patch.available_balance = Math.max(0, Number(w.available_balance) - net);
  } else {
    patch.held_balance = Math.max(0, Number(w.held_balance) - net);
  }

  await updateWallet(supabase, w.id, patch);
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
    if (row.payment_status === "Refunded" || row.booking_status === "Cancelled") {
      await reverseBookingEarning(supabase, row, commissionRate);
      continue;
    }
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
  const wallet = await getOrCreatePractitionerWallet(
    supabase,
    practitionerId,
    commissionRate
  );
  if (!wallet) return { error: "Wallet not found" };

  const { data: walletRow } = await supabase
    .from("practitioner_wallets")
    .select("bank_account_label")
    .eq("id", wallet.id)
    .maybeSingle();

  if (!isBankAccountLinkedForPayout((walletRow as { bank_account_label?: string | null } | null)?.bank_account_label)) {
    return { error: "Bank account details required before requesting a withdrawal" };
  }

  if (amount <= 0) return { error: "Invalid amount" };

  const { data: reservedWallet, error: reserveError } = await supabase
    .from("practitioner_wallets")
    .update({
      available_balance: Number(wallet.available_balance) - amount,
      pending_payout: Number(wallet.pending_payout) + amount,
    })
    .eq("id", wallet.id)
    .gte("available_balance", amount)
    .select()
    .maybeSingle();

  if (reserveError) return { error: reserveError.message };
  if (!reservedWallet) return { error: "Insufficient available balance" };

  const { data: payout, error: payoutError } = await supabase
    .from("practitioner_payouts")
    .insert({
      wallet_id: wallet.id,
      amount,
      status: "Pending",
      notes: "Manual withdrawal — processed by Nature's Grace team within 3–7 business days",
    })
    .select()
    .single();

  if (payoutError || !payout) {
    await updateWallet(supabase, wallet.id, {
      available_balance: Number(reservedWallet.available_balance) + amount,
      pending_payout: Math.max(0, Number(reservedWallet.pending_payout) - amount),
    });
    return { error: payoutError?.message ?? "Could not create payout" };
  }

  const { error: txnError } = await supabase
    .from("practitioner_wallet_transactions")
    .insert({
      wallet_id: wallet.id,
      payout_id: payout.id,
      type: "debit",
      category: "payout",
      amount,
      description: "Payout to Bank Account (pending)",
      is_released: true,
    });

  if (txnError) {
    await supabase.from("practitioner_payouts").delete().eq("id", payout.id);
    await updateWallet(supabase, wallet.id, {
      available_balance: Number(reservedWallet.available_balance) + amount,
      pending_payout: Math.max(0, Number(reservedWallet.pending_payout) - amount),
    });
    return { error: txnError.message };
  }

  return { payoutId: payout.id as string };
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
