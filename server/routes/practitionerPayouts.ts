import type { Express, Request, Response } from "express";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import {
  applyRazorpayPayoutStatus,
  completePayout,
  getPayoutById,
  markPayoutProcessing,
} from "../services/practitionerPayoutLifecycle";
import {
  createRazorpayPayout,
  isRazorpayConfigured,
} from "../services/razorpayX";
import { getBearerUser } from "../middleware/auth";
import { verifyPractitionerPayoutOwnership } from "../services/practitionerWalletLedger";

function paramId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

import { devAutoCompleteEnabled } from "../lib/payoutDev";

async function handleDispatch(req: Request, res: Response) {
  try {
    const user = await getBearerUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const payoutId = paramId(req.params.payoutId);
    const supabase = requireSupabaseAdmin();

    const ownsPayout = await verifyPractitionerPayoutOwnership(supabase, payoutId, user.id);
    if (!ownsPayout) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const existing = await getPayoutById(supabase, payoutId);
    if (!existing) return res.status(404).json({ error: "Payout not found" });

    const { data: claimed } = await supabase
      .from("practitioner_payouts")
      .update({ status: "Processing", notes: "Submitting to RazorpayX" })
      .eq("id", payoutId)
      .eq("status", "Pending")
      .select()
      .maybeSingle();

    if (!claimed) {
      const latest = await getPayoutById(supabase, payoutId);
      return res.status(200).json({
        payoutId: latest?.id ?? payoutId,
        status: latest?.status ?? "Processing",
        message: "Payout already dispatched",
      });
    }

    const payout = claimed as typeof claimed & { amount: number; id: string; notes?: string | null };

    if (isRazorpayConfigured()) {
      const result = await createRazorpayPayout({
        referenceId: payout.id,
        amountInr: Number(payout.amount),
        fundAccountId: (payout as { razorpay_fund_account_id?: string | null }).razorpay_fund_account_id ?? undefined,
        narration: "NG practitioner payout",
      });

      if (!result.ok) {
        await supabase
          .from("practitioner_payouts")
          .update({ status: "Pending", notes: payout.notes ?? null })
          .eq("id", payoutId)
          .eq("status", "Processing");
        return res.status(502).json({ error: result.error });
      }

      await markPayoutProcessing(supabase, payoutId, {
        razorpayPayoutId: result.payoutId,
        razorpayFundAccountId: result.fundAccountId,
        notes: "Submitted to RazorpayX",
      });

      if ((result.status ?? "").toLowerCase() === "processed") {
        const done = await completePayout(supabase, payoutId, {
          razorpayPayoutId: result.payoutId,
          razorpayFundAccountId: result.fundAccountId,
        });
        return res.json({
          payoutId: done.id,
          status: done.status,
          razorpayPayoutId: done.razorpay_payout_id,
        });
      }

      return res.json({
        payoutId,
        status: "Processing",
        razorpayPayoutId: result.payoutId,
        message: "Payout submitted to RazorpayX",
      });
    }

    if (devAutoCompleteEnabled()) {
      const done = await completePayout(supabase, payoutId, {
        notes: "Dev auto-complete (no RazorpayX keys)",
        webhookEvent: "dev.auto_complete",
      });
      return res.json({
        payoutId: done.id,
        status: done.status,
        message: "Payout auto-completed (dev mode)",
        devMode: true,
      });
    }

    await supabase
      .from("practitioner_payouts")
      .update({ status: "Pending", notes: existing.notes ?? null })
      .eq("id", payoutId)
      .eq("status", "Processing");

    return res.json({
      payoutId,
      status: "Pending",
      message: "Payout queued. Configure RAZORPAYX_* or PAYOUT_DEV_AUTO_COMPLETE.",
      razorpayConfigured: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dispatch failed";
    console.error("[practitioner-payouts] dispatch:", err);
    return res.status(500).json({ error: message });
  }
}

export function registerPractitionerPayoutRoutes(app: Express) {
  app.post("/api/practitioner-payouts/:payoutId/dispatch", handleDispatch);
}
