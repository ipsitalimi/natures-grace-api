import type { SupabaseClient } from "@supabase/supabase-js";

export type PayoutStatus =
  | "Pending"
  | "Under Review"
  | "Processing"
  | "Completed"
  | "Failed"
  | "Cancelled"
  | "Rejected";

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

const TERMINAL: PayoutStatus[] = ["Completed", "Failed", "Cancelled", "Rejected"];

export async function getPayoutById(
  supabase: SupabaseClient,
  payoutId: string
): Promise<DbPayoutRow | null> {
  const { data, error } = await supabase
    .from("seller_payouts")
    .select("*")
    .eq("id", payoutId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as DbPayoutRow | null;
}

async function getWallet(
  supabase: SupabaseClient,
  walletId: string
): Promise<DbWalletRow> {
  const { data, error } = await supabase
    .from("seller_wallets")
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
  const { error } = await supabase.from("seller_wallets").update(patch).eq("id", walletId);
  if (error) throw new Error(error.message);
}

async function updatePayoutTxnDescription(
  supabase: SupabaseClient,
  payoutId: string,
  description: string
): Promise<void> {
  const { error } = await supabase
    .from("wallet_transactions")
    .update({ description })
    .eq("payout_id", payoutId)
    .eq("category", "payout");
  if (error) throw new Error(`Could not update payout ledger description: ${error.message}`);
}

/** Sum Pending + Processing payouts and align wallet.pending_payout. */
export async function reconcilePendingPayout(
  supabase: SupabaseClient,
  walletId: string
): Promise<void> {
  const { data: payouts, error } = await supabase
    .from("seller_payouts")
    .select("amount, status")
    .eq("wallet_id", walletId)
    .in("status", ["Pending", "Processing", "Under Review"]);

  if (error) throw new Error(error.message);

  const pendingSum = (payouts ?? []).reduce(
    (sum, p) => sum + Number((p as { amount: number }).amount),
    0
  );

  await updateWalletBalances(supabase, walletId, { pending_payout: pendingSum });
}

async function transitionPayout(
  supabase: SupabaseClient,
  payoutId: string,
  action: "processing" | "completed" | "failed",
  opts: {
    razorpayPayoutId?: string;
    razorpayFundAccountId?: string;
    notes?: string;
    failureReason?: string;
    webhookEvent?: string;
  } = {}
): Promise<DbPayoutRow> {
  const { data, error } = await supabase.rpc("transition_wallet_payout", {
    p_payout_type: "seller",
    p_payout_id: payoutId,
    p_action: action,
    p_razorpay_payout_id: opts.razorpayPayoutId ?? null,
    p_razorpay_fund_account_id: opts.razorpayFundAccountId ?? null,
    p_notes: opts.notes ?? null,
    p_failure_reason: opts.failureReason ?? null,
    p_webhook_event: opts.webhookEvent ?? null,
  });

  if (error) throw new Error(error.message);
  const result = data as { ok?: boolean; error?: string; payout?: DbPayoutRow } | null;
  if (!result?.ok || !result.payout) {
    throw new Error(result?.error ?? "Payout lifecycle transition failed");
  }
  return result.payout;
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
  const existing = await getPayoutById(supabase, payoutId);
  if (!existing) throw new Error("Payout not found");
  if (TERMINAL.includes(existing.status)) return existing;
  return transitionPayout(supabase, payoutId, "processing", opts);
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
  return transitionPayout(supabase, payoutId, "completed", opts);
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
  return transitionPayout(supabase, payoutId, "failed", opts);
}
