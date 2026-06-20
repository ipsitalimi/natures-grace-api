import type { Express, Request, Response } from "express";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import {
  applyRazorpayPayoutStatus,
  completePayout,
  getPayoutById,
  markPayoutProcessing,
} from "../services/payoutLifecycle";
import { applyRazorpayPayoutStatus as applyPractitionerPayoutStatus } from "../services/practitionerPayoutLifecycle";
import {
  createRazorpayPayout,
  isRazorpayConfigured,
  verifyWebhookSignature,
} from "../services/razorpayX";
import { getBearerUser } from "../middleware/auth";
import { verifySellerPayoutOwnership } from "../services/sellerWalletLedger";

function paramId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

import { devAutoCompleteEnabled } from "../lib/payoutDev";

/** POST /api/payouts/:payoutId/dispatch — send to RazorpayX after client creates Pending payout */
async function handleDispatch(req: Request, res: Response) {
  try {
    const user = await getBearerUser(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payoutId = paramId(req.params.payoutId);
    const supabase = requireSupabaseAdmin();
    const payout = await getPayoutById(supabase, payoutId);

    if (!payout) {
      return res.status(404).json({ error: "Payout not found" });
    }

    const ownsPayout = await verifySellerPayoutOwnership(supabase, payoutId, user.id);
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
        narration: "NG seller payout",
      });

      if (!result.ok) {
        return res.status(502).json({ error: result.error });
      }

      await markPayoutProcessing(supabase, payoutId, {
        razorpayPayoutId: result.payoutId,
        razorpayFundAccountId: result.fundAccountId,
        notes: "Submitted to RazorpayX",
      });

      const normalized = (result.status ?? "").toLowerCase();
      if (normalized === "processed") {
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
      message:
        "Payout queued. Configure RAZORPAYX_* keys or set PAYOUT_DEV_AUTO_COMPLETE=true for local testing.",
      razorpayConfigured: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dispatch failed";
    console.error("[payouts] dispatch:", err);
    return res.status(500).json({ error: message });
  }
}

/** POST /api/webhooks/razorpayx — RazorpayX payout status updates */
async function handleRazorpayWebhook(req: Request, res: Response) {
  try {
    const signature = req.header("x-razorpay-signature");
    const rawBody =
      (req as Request & { rawBody?: Buffer }).rawBody ??
      Buffer.from(JSON.stringify(req.body));

    if (!verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const payload = req.body as {
      event?: string;
      payload?: { payout?: { entity?: Record<string, unknown> } };
    };

    const event = payload.event ?? "unknown";
    const entity = (payload.payload?.payout?.entity ?? {}) as {
      id?: string;
      status?: string;
      fund_account_id?: string;
      reference_id?: string;
      failure_reason?: string;
    };

    const supabase = requireSupabaseAdmin();
    const result =
      (await applyRazorpayPayoutStatus(supabase, entity, event)) ??
      (await applyPractitionerPayoutStatus(supabase, entity, event));

    if (!result) {
      return res.status(200).json({ received: true, matched: false });
    }

    return res.status(200).json({
      received: true,
      matched: true,
      payoutId: result.payoutId,
      status: result.status,
      entity: "seller_or_practitioner",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook failed";
    console.error("[payouts] webhook:", err);
    return res.status(500).json({ error: message });
  }
}

/** POST /api/payouts/:payoutId/dev-complete — local testing only */
async function handleDevComplete(req: Request, res: Response) {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }

  try {
    const user = await getBearerUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const supabase = requireSupabaseAdmin();
    const ownsPayout = await verifySellerPayoutOwnership(
      supabase,
      paramId(req.params.payoutId),
      user.id
    );
    if (!ownsPayout) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const done = await completePayout(supabase, paramId(req.params.payoutId), {
      webhookEvent: "dev.manual_complete",
    });
    return res.json({ payoutId: done.id, status: done.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Complete failed";
    return res.status(500).json({ error: message });
  }
}

export function registerPayoutRoutes(app: Express) {
  app.post("/api/payouts/:payoutId/dispatch", handleDispatch);
  app.post("/api/payouts/:payoutId/dev-complete", handleDevComplete);
  app.post("/api/webhooks/razorpayx", handleRazorpayWebhook);
}
