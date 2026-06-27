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

  const wallet = await getOrCreateSellerWallet(supabase, order.seller_id, commissionRate);
  if (!wallet) return;

  if (await hasTransaction(supabase, wallet.id, order.id, "order_earning")) return;

  const net = netEarning(Number(order.total), commissionRate);
  const productName = await loadOrderItemsLabel(supabase, order.id);

  const { error } = await supabase.from("wallet_transactions").insert({
    wallet_id: wallet.id,
    order_id: order.id,
    type: "credit",
    category: "order_earning",
    amount: net,
    description: `Order ${order.order_number} — ${productName}`,
    is_released: false,
  });

  if (error) return;

  await updateWalletBalances(supabase, wallet.id, {
    total_earned: Number(wallet.total_earned) + net,
    held_balance: Number(wallet.held_balance) + net,
  });

  if (order.status === "Delivered") {
    await releaseOrderEarning(supabase, order, commissionRate);
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

  if (await hasTransaction(supabase, wallet.id, order.id, "earning_release")) return;

  const { data: earning } = await supabase
    .from("wallet_transactions")
    .select("*")
    .eq("wallet_id", wallet.id)
    .eq("order_id", order.id)
    .eq("category", "order_earning")
    .maybeSingle();

  if (!earning) {
    await creditOrderEarning(supabase, order, commissionRate);
    return;
  }

  const row = earning as WalletTxnRow;
  if (row.is_released) return;

  const net = Number(row.amount);

  await supabase.from("wallet_transactions").update({ is_released: true }).eq("id", row.id);

  if (!(await hasTransaction(supabase, wallet.id, order.id, "earning_release"))) {
    await supabase.from("wallet_transactions").insert({
      wallet_id: wallet.id,
      order_id: order.id,
      type: "credit",
      category: "earning_release",
      amount: net,
      description: `Released — ${order.order_number}`,
      is_released: true,
    });
  }

  const { data: fresh } = await supabase
    .from("seller_wallets")
    .select("*")
    .eq("id", wallet.id)
    .single();

  if (!fresh) return;

  const w = fresh as WalletRow;
  await updateWalletBalances(supabase, w.id, {
    held_balance: Math.max(0, Number(w.held_balance) - net),
    available_balance: Number(w.available_balance) + net,
  });
}

export async function reverseOrderEarning(
  supabase: SupabaseClient,
  order: OrderRow,
  commissionRate: number
): Promise<void> {
  if (!order.seller_id) return;

  const wallet = await getOrCreateSellerWallet(supabase, order.seller_id, commissionRate);
  if (!wallet) return;

  const { data: earning } = await supabase
    .from("wallet_transactions")
    .select("*")
    .eq("wallet_id", wallet.id)
    .eq("order_id", order.id)
    .eq("category", "order_earning")
    .maybeSingle();

  if (!earning) return;

  const row = earning as WalletTxnRow;
  const net = Number(row.amount);

  if (await hasTransaction(supabase, wallet.id, order.id, "refund")) return;

  await supabase.from("wallet_transactions").insert({
    wallet_id: wallet.id,
    order_id: order.id,
    type: "debit",
    category: "refund",
    amount: net,
    description: `Reversal — ${order.order_number}`,
    is_released: true,
  });

  const { data: fresh } = await supabase
    .from("seller_wallets")
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

  await updateWalletBalances(supabase, w.id, patch);
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

  const { data: walletRow } = await supabase
    .from("seller_wallets")
    .select("bank_account_label")
    .eq("id", wallet.id)
    .maybeSingle();

  if (!isBankAccountLinkedForPayout((walletRow as { bank_account_label?: string | null } | null)?.bank_account_label)) {
    return { error: "Bank account details required before requesting a withdrawal" };
  }

  if (amount <= 0) return { error: "Invalid amount" };

  const { data: reservedWallet, error: reserveError } = await supabase
    .from("seller_wallets")
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
    .from("seller_payouts")
    .insert({
      wallet_id: wallet.id,
      amount,
      status: "Pending",
      notes: "Manual withdrawal — processed by Nature's Grace team within 3–7 business days",
    })
    .select()
    .single();

  if (payoutError || !payout) {
    await updateWalletBalances(supabase, wallet.id, {
      available_balance: Number(reservedWallet.available_balance) + amount,
      pending_payout: Math.max(0, Number(reservedWallet.pending_payout) - amount),
    });
    return { error: payoutError?.message ?? "Could not create payout" };
  }

  const { error: txnError } = await supabase.from("wallet_transactions").insert({
    wallet_id: wallet.id,
    payout_id: payout.id,
    type: "debit",
    category: "payout",
    amount,
    description: "Payout to Bank Account (pending)",
    is_released: true,
  });

  if (txnError) {
    await supabase.from("seller_payouts").delete().eq("id", payout.id);
    await updateWalletBalances(supabase, wallet.id, {
      available_balance: Number(reservedWallet.available_balance) + amount,
      pending_payout: Math.max(0, Number(reservedWallet.pending_payout) - amount),
    });
    return { error: txnError.message };
  }

  return { payoutId: payout.id as string };
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
