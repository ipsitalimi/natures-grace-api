import type { Express, Request, Response } from "express";
import { requireRole } from "../middleware/auth";
import { MANUAL_PAYOUT_MESSAGE } from "../lib/manualPayouts";

/** Legacy endpoint: practitioners cannot queue or dispatch their own payouts. */
async function handleDispatch(req: Request, res: Response) {
  const profile = await requireRole(req, res, "Practitioner");
  if (!profile) return;

  return res.status(409).json({
    error: MANUAL_PAYOUT_MESSAGE,
    manualPayouts: true,
  });
}

export function registerPractitionerPayoutRoutes(app: Express) {
  app.post("/api/practitioner-payouts/:payoutId/dispatch", handleDispatch);
}
