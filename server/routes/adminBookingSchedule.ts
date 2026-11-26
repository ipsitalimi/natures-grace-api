import type { Express, Request, Response } from "express";
import { requireRole } from "../middleware/auth";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";

export function registerAdminBookingScheduleRoutes(app: Express): void {
  app.get("/api/admin/bookings/schedule", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const supabase = requireSupabaseAdmin();
    const from = typeof req.query.from === "string" ? req.query.from : new Date().toISOString().slice(0, 10);
    const to = typeof req.query.to === "string" ? req.query.to : null;

    let query = supabase.from("practitioner_bookings")
      .select("id, booking_number, user_id, practitioner_id, client_name, service_name, session_date, session_time, duration_minutes, booking_status, payment_status, meeting_link")
      .in("booking_status", ["Pending", "Confirmed"])
      .gte("session_date", from)
      .order("session_date", { ascending: true })
      .order("session_time", { ascending: true });

    if (to) query = query.lte("session_date", to);
    const { data, error } = await query.limit(300);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ sessions: data ?? [] });
  });

  app.patch("/api/admin/bookings/:id/schedule", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const bookingId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const body = req.body as {
      sessionDate?: string;
      sessionTime?: string;
      meetingLink?: string | null;
    };

    if (!bookingId) return res.status(400).json({ error: "Booking id is required" });
    if (!body.sessionDate?.trim() || !body.sessionTime?.trim()) {
      return res.status(400).json({ error: "Session date and time are required" });
    }
    if (body.meetingLink && !/^https:\/\//i.test(body.meetingLink.trim())) {
      return res.status(400).json({ error: "Session link must use HTTPS" });
    }

    const supabase = requireSupabaseAdmin();
    const { data, error } = await supabase.rpc("admin_update_practitioner_booking_schedule", {
      p_booking_id: bookingId,
      p_new_session_date: body.sessionDate.trim(),
      p_new_session_time: body.sessionTime.trim(),
      p_meeting_link: body.meetingLink?.trim() || null,
    });

    if (error) return res.status(500).json({ error: error.message });
    const result = data as {
      ok?: boolean;
      error?: string;
      booking_id?: string;
      session_date?: string;
      session_time?: string;
    } | null;
    if (!result?.ok) return res.status(409).json({ error: result?.error ?? "Schedule update failed" });
    return res.json({
      ok: true,
      booking: {
        id: result.booking_id,
        session_date: result.session_date,
        session_time: result.session_time,
        meeting_link: body.meetingLink?.trim() || null,
      },
    });
  });
}
