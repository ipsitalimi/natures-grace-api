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
    const payout = await getPayoutById(supabase, payoutId);
    if (!payout) return res.status(404).json({ error: "Payout not found" });

    const ownsPayout = await verifyPractitionerPayoutOwnership(supabase, payoutId, user.id);
    if (!ownsPayout) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (payout.status !== "Pending") {
      return res.status(200).json({
        payoutId: payout.id,
        status: payout.status,
        message: "Payout already dispatched",
      });
    }

    if (isRazorpayConfigured()) {
      const result = await createRazorpayPayout({
        referenceId: payout.id,
        amountInr: Number(payout.amount),
        fundAccountId: payout.razorpay_fund_account_id ?? undefined,
        narration: "NG practitioner payout",
      });

      if (!result.ok) return res.status(502).json({ error: result.error });

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
