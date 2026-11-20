import type { Express, Request, Response } from "express";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireRole } from "../middleware/auth";
import {
  requestSellerPayout,
  resolveSellerIdForProfile,
  syncSellerWalletFromOrders,
  updateSellerBankDetails,
} from "../services/sellerWalletLedger";
import { dispatchUserNotification } from "../services/notificationDispatch";
import {
  resolvePractitionerIdForProfile,
  syncPractitionerWalletFromBookings,
  updatePractitionerBankDetails,
} from "../services/practitionerWalletLedger";
import { fetchCommissionRate } from "../services/platformSettings";

async function handleSellerSync(req: Request, res: Response) {
  try {
    const profile = await requireRole(req, res, "Seller");
    if (!profile) return;

    const supabase = requireSupabaseAdmin();
    const sellerId = await resolveSellerIdForProfile(supabase, profile.id);
    if (!sellerId) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    const commissionRate = await fetchCommissionRate(supabase);
    await syncSellerWalletFromOrders(supabase, sellerId, commissionRate);
    return res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    return res.status(500).json({ error: message });
  }
}

async function handleSellerBankDetails(req: Request, res: Response) {
  try {
    const profile = await requireRole(req, res, "Seller");
    if (!profile) return;

    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const bankName = typeof body.bankName === "string" ? body.bankName : "";
    const last4 = typeof body.last4 === "string" ? body.last4 : "";
    const accountHolder = typeof body.accountHolder === "string" ? body.accountHolder : "";

    const supabase = requireSupabaseAdmin();
    const sellerId = await resolveSellerIdForProfile(supabase, profile.id);
    if (!sellerId) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    const commissionRate = await fetchCommissionRate(supabase);
    const result = await updateSellerBankDetails(supabase, sellerId, commissionRate, {
      bankName: bankName ?? "",
      last4: last4 ?? "",
      accountHolder: accountHolder ?? "",
    });

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save bank details";
    return res.status(500).json({ error: message });
  }
}

async function handleSellerRequestPayout(req: Request, res: Response) {
  try {
    const profile = await requireRole(req, res, "Seller");
    if (!profile) return;

    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const amount = body.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) {
      return res.status(400).json({ error: "Enter a valid positive payout amount" });
    }

    const supabase = requireSupabaseAdmin();
    const sellerId = await resolveSellerIdForProfile(supabase, profile.id);
    if (!sellerId) {
      return res.status(404).json({ error: "Seller profile not found" });
    }

    const commissionRate = await fetchCommissionRate(supabase);
    const result = await requestSellerPayout(
      supabase,
      sellerId,
      Number(amount),
      commissionRate
    );

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    await dispatchUserNotification(supabase, {
      userId: profile.id,
      event: "withdrawal_received",
      message: `Withdrawal request of ₹${Number(amount).toLocaleString("en-IN")} received. Processed within 3–7 business days.`,
      linkRoute: "Main",
      emailVars: { amount: `₹${Number(amount).toLocaleString("en-IN")}` },
    });

    return res.json({ payoutId: result.payoutId, status: "Pending" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Payout request failed";
    return res.status(500).json({ error: message });
  }
}

async function handlePractitionerSync(req: Request, res: Response) {
  try {
    const profile = await requireRole(req, res, "Practitioner");
    if (!profile) return;

    const supabase = requireSupabaseAdmin();
    const practitionerId = await resolvePractitionerIdForProfile(supabase, profile.id);
    if (!practitionerId) {
      return res.status(404).json({ error: "Practitioner profile not found" });
    }

    const commissionRate = await fetchCommissionRate(supabase);
    await syncPractitionerWalletFromBookings(
      supabase,
      practitionerId,
      commissionRate
    );
    return res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    return res.status(500).json({ error: message });
  }
}

async function handlePractitionerBankDetails(req: Request, res: Response) {
  try {
    const profile = await requireRole(req, res, "Practitioner");
    if (!profile) return;

    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const bankName = typeof body.bankName === "string" ? body.bankName : "";
    const last4 = typeof body.last4 === "string" ? body.last4 : "";
    const accountHolder = typeof body.accountHolder === "string" ? body.accountHolder : "";

    const supabase = requireSupabaseAdmin();
    const practitionerId = await resolvePractitionerIdForProfile(supabase, profile.id);
    if (!practitionerId) {
      return res.status(404).json({ error: "Practitioner profile not found" });
    }

    const commissionRate = await fetchCommissionRate(supabase);
    const result = await updatePractitionerBankDetails(
      supabase,
      practitionerId,
      commissionRate,
      {
        bankName: bankName ?? "",
        last4: last4 ?? "",
        accountHolder: accountHolder ?? "",
      }
    );

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save bank details";
    return res.status(500).json({ error: message });
  }
}

async function handlePractitionerRequestPayout(req: Request, res: Response) {
  const profile = await requireRole(req, res, "Practitioner");
  if (!profile) return;

  // Practitioner payouts are reconciled and transferred manually by the admin
  // team on the agreed payout cycle. Do not create self-service withdrawal rows.
  return res.status(409).json({
    error: "Practitioner payouts are processed manually by the Nature's Grace admin team. You do not need to request a withdrawal.",
    manualPayouts: true,
  });
}

export function registerWalletLedgerRoutes(app: Express) {
  app.post("/api/wallet/seller/sync", handleSellerSync);
  app.post("/api/wallet/seller/bank-details", handleSellerBankDetails);
  app.post("/api/wallet/seller/request-payout", handleSellerRequestPayout);
  app.post("/api/wallet/practitioner/sync", handlePractitionerSync);
  app.post("/api/wallet/practitioner/bank-details", handlePractitionerBankDetails);
  app.post("/api/wallet/practitioner/request-payout", handlePractitionerRequestPayout);
}
