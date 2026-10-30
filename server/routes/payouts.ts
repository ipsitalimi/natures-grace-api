import type { Express, Request, Response } from "express";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import {
  completePayout,
  getPayoutById,
  reconcilePendingPayout,
} from "../services/payoutLifecycle";
import { getBearerUser } from "../middleware/auth";
import { verifySellerPayoutOwnership } from "../services/sellerWalletLedger";
import {
  MANUAL_PAYOUT_MESSAGE,
  MANUAL_PAYOUT_NOTES,
  MANUAL_PAYOUT_STATUS,
} from "../lib/manualPayouts";

function paramId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

/** POST /api/payouts/:payoutId/dispatch — queue payout for manual admin transfer */
async function handleDispatch(req: Request, res: Response) {
  try {
    const user = await getBearerUser(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payoutId = paramId(req.params.payoutId);
    const supabase = requireSupabaseAdmin();

    const ownsPayout = await verifySellerPayoutOwnership(supabase, payoutId, user.id);
    if (!ownsPayout) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const existing = await getPayoutById(supabase, payoutId);
    if (!existing) {
      return res.status(404).json({ error: "Payout not found" });
    }

    if (existing.status !== "Pending") {
      return res.status(200).json({
        payoutId: existing.id,
        status: existing.status,
        message:
          existing.status === MANUAL_PAYOUT_STATUS
            ? MANUAL_PAYOUT_MESSAGE
            : "Payout already submitted",
        manualPayouts: true,
      });
    }

    const { data: updated, error } = await supabase
      .from("seller_payouts")
      .update({
        status: MANUAL_PAYOUT_STATUS,
        notes: MANUAL_PAYOUT_NOTES,
      })
      .eq("id", payoutId)
      .eq("status", "Pending")
      .select()
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!updated) {
      const latest = await getPayoutById(supabase, payoutId);
      return res.status(200).json({
        payoutId: latest?.id ?? payoutId,
        status: latest?.status ?? MANUAL_PAYOUT_STATUS,
        message: MANUAL_PAYOUT_MESSAGE,
        manualPayouts: true,
      });
    }

    await reconcilePendingPayout(supabase, (updated as { wallet_id: string }).wallet_id);

    return res.json({
      payoutId: updated.id,
      status: MANUAL_PAYOUT_STATUS,
      message: MANUAL_PAYOUT_MESSAGE,
      manualPayouts: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dispatch failed";
    console.error("[payouts] dispatch:", err);
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
}
