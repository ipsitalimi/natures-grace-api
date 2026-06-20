import type { SupabaseClient } from "@supabase/supabase-js";

export type PayoutStatus =
  | "Pending"
  | "Processing"
  | "Completed"
  | "Failed"
  | "Cancelled";

export type DbPayoutRow = {
  id: string;
  wallet_id: string;
  amount: number;
  status: PayoutStatus;
  razorpay_payout_id: string | null;
  razorpay_fund_account_id: string | null;
  notes: string | null;
  failure_reason: string | null;
  last_webhook_event: string | null;
  created_at: string;
  completed_at: string | null;
};

export type DbWalletRow = {
  id: string;
  available_balance: number;
  pending_payout: number;
  held_balance: number;
  total_earned: number;
};

const TERMINAL: PayoutStatus[] = ["Completed", "Failed", "Cancelled"];

export async function getPayoutById(
  supabase: SupabaseClient,
  payoutId: string
): Promise<DbPayoutRow | null> {
  const { data, error } = await supabase
    .from("practitioner_payouts")
    .select("*")
    .eq("id", payoutId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as DbPayoutRow | null;
}

export async function getPayoutByRazorpayId(
  supabase: SupabaseClient,
  razorpayPayoutId: string
): Promise<DbPayoutRow | null> {
  const { data, error } = await supabase
    .from("practitioner_payouts")
    .select("*")
    .eq("razorpay_payout_id", razorpayPayoutId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as DbPayoutRow | null;
}

async function getWallet(
  supabase: SupabaseClient,
  walletId: string
): Promise<DbWalletRow> {
  const { data, error } = await supabase
    .from("practitioner_wallets")
    .select("id, available_balance, pending_payout, held_balance, total_earned")
    .eq("id", walletId)
    .single();

  if (error || !data) throw new Error(error?.message ?? "Wallet not found");
  return data as DbWalletRow;
}

async function updateWalletBalances(
  supabase: SupabaseClient,
  walletId: string,
  patch: Partial<Pick<DbWalletRow, "available_balance" | "pending_payout" | "held_balance" | "total_earned">>
): Promise<void> {
  const { error } = await supabase.from("practitioner_wallets").update(patch).eq("id", walletId);
  if (error) throw new Error(error.message);
}

async function updatePayoutTxnDescription(
  supabase: SupabaseClient,
  payoutId: string,
  description: string
): Promise<void> {
  await supabase
    .from("practitioner_wallet_transactions")
    .update({ description })
    .eq("payout_id", payoutId)
    .eq("category", "payout");
}

/** Sum Pending + Processing payouts and align wallet.pending_payout. */
export async function reconcilePendingPayout(
  supabase: SupabaseClient,
  walletId: string
): Promise<void> {
  const { data: payouts, error } = await supabase
    .from("practitioner_payouts")
    .select("amount, status")
    .eq("wallet_id", walletId)
    .in("status", ["Pending", "Processing"]);

  if (error) throw new Error(error.message);

  const pendingSum = (payouts ?? []).reduce(
    (sum, p) => sum + Number((p as { amount: number }).amount),
    0
  );

  await updateWalletBalances(supabase, walletId, { pending_payout: pendingSum });
}

export async function markPayoutProcessing(
  supabase: SupabaseClient,
  payoutId: string,
  opts: {
    razorpayPayoutId?: string;
    razorpayFundAccountId?: string;
    notes?: string;
    webhookEvent?: string;
  }
): Promise<DbPayoutRow> {
  const payout = await getPayoutById(supabase, payoutId);
  if (!payout) throw new Error("Payout not found");
  if (TERMINAL.includes(payout.status)) return payout;

  const { data, error } = await supabase
    .from("practitioner_payouts")
    .update({
      status: "Processing",
      razorpay_payout_id: opts.razorpayPayoutId ?? payout.razorpay_payout_id,
      razorpay_fund_account_id:
        opts.razorpayFundAccountId ?? payout.razorpay_fund_account_id,
      notes: opts.notes ?? payout.notes,
      last_webhook_event: opts.webhookEvent ?? null,
    })
    .eq("id", payoutId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  await reconcilePendingPayout(supabase, payout.wallet_id);
  return data as DbPayoutRow;
}

export async function completePayout(
  supabase: SupabaseClient,
  payoutId: string,
  opts: {
    razorpayPayoutId?: string;
    razorpayFundAccountId?: string;
    webhookEvent?: string;
    notes?: string;
  } = {}
): Promise<DbPayoutRow> {
  const payout = await getPayoutById(supabase, payoutId);
  if (!payout) throw new Error("Payout not found");
  if (payout.status === "Completed") return payout;

  const amount = Number(payout.amount);
  const wallet = await getWallet(supabase, payout.wallet_id);

  const { data, error } = await supabase
    .from("practitioner_payouts")
    .update({
      status: "Completed",
      razorpay_payout_id: opts.razorpayPayoutId ?? payout.razorpay_payout_id,
      razorpay_fund_account_id:
        opts.razorpayFundAccountId ?? payout.razorpay_fund_account_id,
      completed_at: new Date().toISOString(),
      last_webhook_event: opts.webhookEvent ?? null,
      failure_reason: null,
      notes: opts.notes ?? payout.notes,
    })
    .eq("id", payoutId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  await updateWalletBalances(supabase, payout.wallet_id, {
    pending_payout: Math.max(0, Number(wallet.pending_payout) - amount),
  });

  await updatePayoutTxnDescription(
    supabase,
    payoutId,
    "Payout to Bank Account (completed)"
  );

  await reconcilePendingPayout(supabase, payout.wallet_id);
  return data as DbPayoutRow;
}

export async function failPayout(
  supabase: SupabaseClient,
  payoutId: string,
  opts: {
    failureReason?: string;
    razorpayPayoutId?: string;
    webhookEvent?: string;
  } = {}
): Promise<DbPayoutRow> {
  const payout = await getPayoutById(supabase, payoutId);
  if (!payout) throw new Error("Payout not found");
  if (payout.status === "Failed") return payout;
  if (payout.status === "Completed") {
    throw new Error("Cannot fail a completed payout");
  }

  const amount = Number(payout.amount);
  const wallet = await getWallet(supabase, payout.wallet_id);

  const { data, error } = await supabase
    .from("practitioner_payouts")
    .update({
      status: "Failed",
      failure_reason: opts.failureReason ?? "Payout failed",
      razorpay_payout_id: opts.razorpayPayoutId ?? payout.razorpay_payout_id,
      last_webhook_event: opts.webhookEvent ?? null,
    })
    .eq("id", payoutId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  const wasReserved =
    payout.status === "Pending" || payout.status === "Processing";

  if (wasReserved) {
    await updateWalletBalances(supabase, payout.wallet_id, {
      pending_payout: Math.max(0, Number(wallet.pending_payout) - amount),
      available_balance: Number(wallet.available_balance) + amount,
    });

    const { data: existingRefund } = await supabase
      .from("practitioner_wallet_transactions")
      .select("id")
      .eq("payout_id", payoutId)
      .eq("category", "adjustment")
      .eq("type", "credit")
      .maybeSingle();

    if (!existingRefund) {
      await supabase.from("practitioner_wallet_transactions").insert({
        wallet_id: payout.wallet_id,
        payout_id: payoutId,
        type: "credit",
        category: "adjustment",
        amount,
        description: `Payout failed — ${opts.failureReason ?? "refunded to wallet"}`,
        is_released: true,
      });
    }
  }

  await updatePayoutTxnDescription(
    supabase,
    payoutId,
    `Payout failed — ${opts.failureReason ?? "not processed"}`
  );

  await reconcilePendingPayout(supabase, payout.wallet_id);
  return data as DbPayoutRow;
}

/** Resolve payout from RazorpayX webhook entity. */
export async function applyRazorpayPayoutStatus(
  supabase: SupabaseClient,
  entity: {
    id?: string;
    status?: string;
    fund_account_id?: string;
    reference_id?: string;
    failure_reason?: string;
  },
  webhookEvent: string
): Promise<{ payoutId: string; status: PayoutStatus } | null> {
  const razorpayId = entity.id;
  const referenceId = entity.reference_id;

  let payout =
    (razorpayId ? await getPayoutByRazorpayId(supabase, razorpayId) : null) ??
    (referenceId ? await getPayoutById(supabase, referenceId) : null);

  if (!payout) return null;

  const normalized = (entity.status ?? "").toLowerCase();

  if (
    normalized === "processed" ||
    webhookEvent === "payout.processed" ||
    webhookEvent === "payout.updated.processed"
  ) {
    const done = await completePayout(supabase, payout.id, {
      razorpayPayoutId: razorpayId ?? payout.razorpay_payout_id ?? undefined,
      razorpayFundAccountId: entity.fund_account_id ?? undefined,
      webhookEvent,
    });
    return { payoutId: done.id, status: done.status };
  }

  if (
    normalized === "failed" ||
    normalized === "reversed" ||
    normalized === "cancelled" ||
    webhookEvent.includes("failed") ||
    webhookEvent.includes("reversed")
  ) {
    const failed = await failPayout(supabase, payout.id, {
      failureReason: entity.failure_reason ?? normalized,
      razorpayPayoutId: razorpayId ?? undefined,
      webhookEvent,
    });
    return { payoutId: failed.id, status: failed.status };
  }

  if (
    normalized === "processing" ||
    normalized === "queued" ||
    normalized === "pending" ||
    webhookEvent === "payout.initiated" ||
    webhookEvent === "payout.queued"
  ) {
    const processing = await markPayoutProcessing(supabase, payout.id, {
      razorpayPayoutId: razorpayId ?? undefined,
      razorpayFundAccountId: entity.fund_account_id ?? undefined,
      webhookEvent,
    });
    return { payoutId: processing.id, status: processing.status };
  }

  return { payoutId: payout.id, status: payout.status };
}
