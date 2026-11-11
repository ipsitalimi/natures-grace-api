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
    const { data: booking, error: fetchError } = await supabase
      .from("practitioner_bookings")
      .select("id, booking_status")
      .eq("id", bookingId)
      .maybeSingle();

    if (fetchError || !booking) return res.status(404).json({ error: "Booking not found" });
    if (!["Pending", "Confirmed"].includes(String(booking.booking_status))) {
      return res.status(400).json({ error: "Only upcoming bookings can be scheduled" });
    }

    const { data, error } = await supabase.from("practitioner_bookings")
      .update({
        session_date: body.sessionDate.trim(),
        session_time: body.sessionTime.trim(),
        meeting_link: body.meetingLink?.trim() || null,
      })
      .eq("id", bookingId)
      .select("id, session_date, session_time, meeting_link")
      .single();

    if (error || !data) return res.status(500).json({ error: error?.message ?? "Schedule update failed" });
    return res.json({ ok: true, booking: data });
  });
}
