import type { Express, Request, Response } from "express";
import { requireBearerUser } from "../middleware/auth";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";

const RESCHEDULE_DEADLINE_HOURS = 36;

export function registerBookingRescheduleRoutes(app: Express): void {
  app.post("/api/bookings/:id/reschedule", async (req: Request, res: Response) => {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const bookingId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const { sessionDate, sessionTime } = req.body as { sessionDate?: string; sessionTime?: string };
    if (!bookingId || !sessionDate?.trim() || !sessionTime?.trim()) {
      return res.status(400).json({ error: "Booking id, new date, and new time are required" });
    }

    const supabase = requireSupabaseAdmin();
    const { data, error } = await supabase.rpc("reschedule_user_practitioner_booking", {
      p_booking_id: bookingId,
      p_user_id: user.id,
      p_new_session_date: sessionDate.trim(),
      p_new_session_time: sessionTime.trim(),
      p_deadline_hours: RESCHEDULE_DEADLINE_HOURS,
    });

    if (error) {
      console.error("[bookingReschedule] RPC failed:", error.message);
      return res.status(500).json({ error: "Rescheduling could not be completed. Please try again." });
    }

    const result = data as { ok?: boolean; error?: string; booking_id?: string; session_date?: string; session_time?: string };
    if (!result?.ok) return res.status(400).json({ error: result?.error ?? "Rescheduling failed" });

    return res.json({ ok: true, bookingId: result.booking_id, sessionDate: result.session_date, sessionTime: result.session_time });
  });
}
