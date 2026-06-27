import type { Express, Request, Response } from "express";
import { requireBearerUser, requireRole } from "../middleware/auth";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { sendEmailToUserId } from "../services/email/emailService";
import { insertActivityLog } from "../services/activityLogAdmin";

export function registerAccountRoutes(app: Express): void {
  const performAccountDeletion = async (
    supabase: ReturnType<typeof requireSupabaseAdmin>,
    userId: string
  ): Promise<{ error?: string }> => {
    await supabase
      .from("profiles")
      .update({
        full_name: "Deleted User",
        email: `deleted+${userId.slice(0, 8)}@deleted.local`,
        phone: null,
        status: "Deleted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    await supabase
      .from("account_deletion_requests")
      .update({
        status: "completed",
        processed_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    const { error: deleteError } = await supabase.auth.admin.deleteUser(userId);
    if (deleteError) {
      return { error: deleteError.message };
    }

    return {};
  };

  app.post("/api/account/delete", async (req: Request, res: Response) => {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const supabase = requireSupabaseAdmin();
    const result = await performAccountDeletion(supabase, user.id);
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }

    return res.json({ ok: true });
  });

  app.post("/api/account/request-deletion", async (req: Request, res: Response) => {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const { reason } = req.body as { reason?: string };
    const supabase = requireSupabaseAdmin();
    const trimmedReason = reason?.trim() || null;

    const { data: existing } = await supabase
      .from("account_deletion_requests")
      .select("status, requested_at")
      .eq("user_id", user.id)
      .maybeSingle();

    const nextStatus =
      existing?.status === "cancelled" || !existing ? "pending" : existing.status;
    const requestedAt =
      existing?.status === "cancelled" || !existing
        ? new Date().toISOString()
        : existing.requested_at;

    const { error: upsertError } = await supabase.from("account_deletion_requests").upsert(
      {
        user_id: user.id,
        reason: trimmedReason,
        status: nextStatus,
        requested_at: requestedAt,
      },
      { onConflict: "user_id" }
    );

    if (upsertError) {
      return res.status(400).json({ error: upsertError.message });
    }

    await supabase
      .from("profiles")
      .update({ status: "Deletion Requested", updated_at: new Date().toISOString() })
      .eq("id", user.id);

    void sendEmailToUserId(supabase, user.id, "account_deletion_requested", {
      name: user.email?.split("@")[0] ?? "there",
    });

    return res.json({ ok: true });
  });

  app.post("/api/admin/users/:id/complete-deletion", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const userId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const supabase = requireSupabaseAdmin();

    const result = await performAccountDeletion(supabase, userId);
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }

    await insertActivityLog(supabase, {
      actorId: admin.id,
      actorName: admin.email,
      actionType: "user",
      description: `Completed account deletion for user ${userId}`,
      targetType: "user",
      targetId: userId,
    });

    return res.json({ ok: true });
  });
}
