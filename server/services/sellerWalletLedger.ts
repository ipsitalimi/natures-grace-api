import type { SupabaseClient } from "@supabase/supabase-js";
import { isBankAccountLinkedForPayout, validateBankDetailsInput } from "../lib/walletBank";

type OrderRow = {
  id: string;
  order_number: string;
  seller_id: string | null;
  status: string;
  payment_status: string;
  total: number;
};

type WalletRow = {
  id: string;
  seller_id: string | null;
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

async function getOrCreateSellerWallet(
  supabase: SupabaseClient,
  sellerId: string,
  commissionRate: number
): Promise<WalletRow | null> {
  const { data: existing } = await supabase
    .from("seller_wallets")
    .select("*")
    .eq("seller_id", sellerId)
    .maybeSingle();

  if (existing) return existing as WalletRow;

  const { data, error } = await supabase
    .from("seller_wallets")
    .insert({
      seller_id: sellerId,
      commission_rate: commissionRate,
      bank_account_label: null,
      next_payout_date: null,
    })
    .select()
    .single();

  if (error || !data) return null;
  return data as WalletRow;
}

async function updateWalletBalances(
  supabase: SupabaseClient,
  walletId: string,
  patch: Partial<Pick<WalletRow, "available_balance" | "pending_payout" | "held_balance" | "total_earned">>
): Promise<void> {
  await supabase.from("seller_wallets").update(patch).eq("id", walletId);
}

async function hasTransaction(
  supabase: SupabaseClient,
  walletId: string,
  orderId: string,
  category: string
): Promise<boolean> {
  const { data } = await supabase
    .from("wallet_transactions")
    .select("id")
    .eq("wallet_id", walletId)
    .eq("order_id", orderId)
    .eq("category", category)
    .maybeSingle();
  return Boolean(data);
}

async function loadOrderItemsLabel(
  supabase: SupabaseClient,
  orderId: string
): Promise<string> {
  const { data: items } = await supabase
    .from("order_items")
    .select("product_name")
    .eq("order_id", orderId)
    .limit(1);
  return (items?.[0] as { product_name?: string } | undefined)?.product_name ?? "Order items";
}

export async function creditOrderEarning(
  supabase: SupabaseClient,
  order: OrderRow,
  commissionRate: number
): Promise<void> {
  if (order.payment_status !== "Paid" || !order.seller_id) return;

  // Database RPC performs the wallet/ledger credit atomically and idempotently.
  const { data, error } = await supabase.rpc("credit_seller_order_earning", {
    p_order_id: order.id,
    p_commission_rate: commissionRate,
  });
  if (error) {
    console.error("[sellerWalletLedger] atomic earning credit:", error.message);
    return;
  }
  const result = data as { ok?: boolean; error?: string } | null;
  if (result?.ok === false) {
    console.warn("[sellerWalletLedger] earning credit skipped:", result.error ?? "unknown error");
  }
}

export async function releaseOrderEarning(
  supabase: SupabaseClient,
  order: OrderRow,
  commissionRate: number
): Promise<void> {
  if (order.payment_status !== "Paid" || order.status !== "Delivered" || !order.seller_id) {
    return;
  }

  const wallet = await getOrCreateSellerWallet(supabase, order.seller_id, commissionRate);
  if (!wallet) return;

  const { data, error } = await supabase.rpc("release_wallet_earning", {
    p_wallet_type: "seller",
    p_wallet_id: wallet.id,
    p_order_or_booking_id: order.id,
    p_description: `Released — ${order.order_number}`,
  });
  if (error) {
    console.error("[sellerWalletLedger] atomic earning release:", error.message);
    return;
  }
  const result = data as { ok?: boolean; error?: string } | null;
  if (result?.ok === false) {
    console.warn("[sellerWalletLedger] earning release skipped:", result.error ?? "unknown error");
  }
}

export async function reverseOrderEarning(
  supabase: SupabaseClient,
  order: OrderRow,
  commissionRate: number
): Promise<void> {
  if (!order.seller_id) return;

  const wallet = await getOrCreateSellerWallet(supabase, order.seller_id, commissionRate);
  if (!wallet) return;

  const { data, error } = await supabase.rpc("reverse_wallet_earning", {
    p_wallet_type: "seller",
    p_wallet_id: wallet.id,
    p_order_or_booking_id: order.id,
    p_description: `Reversal — ${order.order_number}`,
  });
  if (error) {
    console.error("[sellerWalletLedger] atomic earning reversal:", error.message);
    return;
  }
  const result = data as { ok?: boolean; error?: string } | null;
  if (result?.ok === false) {
    console.warn("[sellerWalletLedger] earning reversal skipped:", result.error ?? "unknown error");
  }
}

export async function syncSellerWalletFromOrders(
  supabase: SupabaseClient,
  sellerId: string,
  commissionRate: number
): Promise<void> {
  const { data: orders } = await supabase
    .from("orders")
    .select("id, order_number, seller_id, status, payment_status, total")
    .eq("seller_id", sellerId);

  for (const order of (orders ?? []) as OrderRow[]) {
    if (order.payment_status === "Refunded" || order.status === "Cancelled") {
      await reverseOrderEarning(supabase, order, commissionRate);
      continue;
    }
    if (order.payment_status === "Paid") {
      await creditOrderEarning(supabase, order, commissionRate);
      if (order.status === "Delivered") {
        await releaseOrderEarning(supabase, order, commissionRate);
      }
    }
  }
}

export async function updateSellerBankDetails(
  supabase: SupabaseClient,
  sellerId: string,
  commissionRate: number,
  input: { bankName: string; last4: string; accountHolder: string }
): Promise<{ error?: string }> {
  const validated = validateBankDetailsInput(input);
  if (!validated.ok) return { error: validated.error };

  const wallet = await getOrCreateSellerWallet(supabase, sellerId, commissionRate);
  if (!wallet) return { error: "Wallet not found" };

  const { error } = await supabase
    .from("seller_wallets")
    .update({ bank_account_label: validated.label })
    .eq("id", wallet.id);

  if (error) return { error: error.message };
  return {};
}

export async function requestSellerPayout(
  supabase: SupabaseClient,
  sellerId: string,
  amount: number,
  commissionRate: number
): Promise<{ payoutId?: string; error?: string }> {
  const wallet = await getOrCreateSellerWallet(supabase, sellerId, commissionRate);
  if (!wallet) return { error: "Wallet not found" };

  const { data: walletRow, error: walletError } = await supabase
    .from("seller_wallets")
    .select("bank_account_label")
    .eq("id", wallet.id)
    .maybeSingle();
  if (walletError) return { error: walletError.message };
  if (!isBankAccountLinkedForPayout((walletRow as { bank_account_label?: string | null } | null)?.bank_account_label)) {
    return { error: "Bank account details required before requesting a withdrawal" };
  }
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Invalid amount" };

  const { data, error } = await supabase.rpc("request_wallet_payout", {
    p_payout_type: "seller",
    p_wallet_id: wallet.id,
    p_amount: Math.round(amount * 100) / 100,
    p_notes: "Manual withdrawal — processed by Nature's Grace team within 3–7 business days",
  });
  if (error) return { error: error.message };
  const result = data as { ok?: boolean; error?: string; payout_id?: string } | null;
  if (!result?.ok || !result.payout_id) return { error: result?.error ?? "Could not create payout" };
  return { payoutId: result.payout_id };
}

export async function verifySellerPayoutOwnership(
  supabase: SupabaseClient,
  payoutId: string,
  profileId: string
): Promise<boolean> {
  const { data: payout } = await supabase
    .from("seller_payouts")
    .select("wallet_id")
    .eq("id", payoutId)
    .maybeSingle();

  if (!payout?.wallet_id) return false;

  const { data: wallet } = await supabase
    .from("seller_wallets")
    .select("seller_id")
    .eq("id", payout.wallet_id)
    .maybeSingle();

  if (!wallet?.seller_id) return false;

  const { data: seller } = await supabase
    .from("sellers")
    .select("profile_id")
    .eq("id", wallet.seller_id)
    .maybeSingle();

  return seller?.profile_id === profileId;
}

export async function resolveSellerIdForProfile(
  supabase: SupabaseClient,
  profileId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("sellers")
    .select("id")
    .eq("profile_id", profileId)
    .maybeSingle();
  return data?.id ?? null;
}
