import type { Express, Request, Response } from "express";
import { requireBearerUser } from "../middleware/auth";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";

export function registerBookingCancellationRoutes(app: Express): void {
  app.post("/api/bookings/:id/cancel", async (req: Request, res: Response) => {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const bookingId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const { notes } = req.body as { notes?: string };
    if (!bookingId) return res.status(400).json({ error: "Booking id is required" });

    const supabase = requireSupabaseAdmin();
    const { data, error } = await supabase.rpc("cancel_user_practitioner_booking", {
      p_booking_id: bookingId,
      p_user_id: user.id,
      p_description: notes?.trim() || null,
    });

    if (error) {
      console.error("[bookingCancellation] RPC failed:", error.message);
      return res.status(500).json({ error: "Cancellation could not be completed. Please try again." });
    }

    const result = data as { ok?: boolean; error?: string; booking_id?: string; refund_request_id?: string | null };
    if (!result?.ok) {
      return res.status(400).json({ error: result?.error ?? "Cancellation failed" });
    }

    return res.json({
      ok: true,
      bookingId: result.booking_id,
      refundRequestId: result.refund_request_id ?? null,
      refundRequested: Boolean(result.refund_request_id),
    });
  });
}
