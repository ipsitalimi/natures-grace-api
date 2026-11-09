import type { Express, Request, Response } from "express";
import { requireBearerUser } from "../middleware/auth";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { calculateBookingRefund, fetchBookingCancellationPolicy } from "../services/bookingCancellationPolicy";

export function registerBookingCancellationRoutes(app: Express): void {
  app.post("/api/bookings/:id/cancel", async (req: Request, res: Response) => {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const bookingId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const body = req.body as { notes?: unknown } | null;
    if (!bookingId || bookingId === "undefined" || bookingId === "null") {
      return res.status(400).json({ error: "Booking id is required" });
    }
    if (body?.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
      return res.status(400).json({ error: "Cancellation notes must be text" });
    }
    const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 1000) : "";

    const supabase = requireSupabaseAdmin();
    const { data: booking, error: bookingError } = await supabase
      .from("practitioner_bookings")
      .select("id, user_id, payment_status, amount, total_paid_amount_inr, session_date, session_time")
      .eq("id", bookingId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (bookingError || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    let policySnapshot: Record<string, unknown> | null = null;
    let refundAmount: number | null = null;
    if (booking.payment_status === "Paid") {
      const policy = await fetchBookingCancellationPolicy(supabase);
      const calculation = calculateBookingRefund({
        amountInr: Number((booking as { total_paid_amount_inr?: number | null }).total_paid_amount_inr ?? booking.amount),
        sessionDate: String(booking.session_date ?? ""),
        sessionTime: String(booking.session_time ?? ""),
        policy,
      });
      if ("error" in calculation) {
        return res.status(400).json({ error: calculation.error });
      }
      refundAmount = calculation.refundAmountInr;
      policySnapshot = {
        freeCancellationHours: policy.freeCancellationHours,
        cancellationFeePercent: policy.cancellationFeePercent,
        sessionStartsAt: calculation.sessionStartsAt,
        hoursUntilSession: calculation.hoursUntilSession,
        freeCancellation: calculation.freeCancellation,
        appliedFeePercent: calculation.cancellationFeePercent,
        refundPercent: calculation.refundPercent,
        bookingAmountInr: Number((booking as { total_paid_amount_inr?: number | null }).total_paid_amount_inr ?? booking.amount),
        refundAmountInr: calculation.refundAmountInr,
        calculatedAt: new Date().toISOString(),
      };
    }

    const { data, error } = await supabase.rpc("cancel_user_practitioner_booking", {
      p_booking_id: bookingId,
      p_user_id: user.id,
      p_description: notes || null,
      p_cancellation_policy_snapshot: policySnapshot,
      p_refund_amount: refundAmount,
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
