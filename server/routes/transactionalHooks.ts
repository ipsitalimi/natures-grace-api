import type { Express, Request, Response } from "express";
import { requireBearerUser, requireRole } from "../middleware/auth";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { checkRateLimit } from "../lib/rateLimit";
import { dispatchUserNotification, type NotificationEvent } from "../services/notificationDispatch";
import { sendEmailToUserId, sendTransactionalEmail, type EmailTemplateId } from "../services/email/emailService";

const AUTH_TEMPLATES: EmailTemplateId[] = [
  "account_created",
  "email_verified",
  "password_changed",
  "password_reset_requested",
];

export function registerTransactionalHooksRoutes(app: Express) {
  app.post("/api/hooks/auth-email", async (req: Request, res: Response) => {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const { template } = req.body as { template?: EmailTemplateId };
    if (!template || !AUTH_TEMPLATES.includes(template)) {
      return res.status(400).json({ error: "Invalid template" });
    }

    const result = await sendEmailToUserId(requireSupabaseAdmin(), user.id, template);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json({ ok: true, skipped: result.skipped });
  });

  app.post("/api/hooks/password-reset-requested", async (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };
    if (!email?.trim()) return res.status(400).json({ error: "Email required" });

    const rateKey = `password-reset:${req.ip ?? "unknown"}:${email.trim().toLowerCase()}`;
    const limit = checkRateLimit(rateKey, 3, 15 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many password reset requests. Try again later.",
        retryAfterSec: limit.retryAfterSec,
      });
    }

    const result = await sendTransactionalEmail("password_reset_requested", email.trim(), {
      name: "there",
    });
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json({ ok: true, skipped: result.skipped });
  });

  app.post("/api/hooks/notify-user", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const { userId, event, message, linkRoute, linkTargetId, emailVars, emailTemplate } =
      req.body as {
        userId?: string;
        event?: NotificationEvent;
        message?: string;
        linkRoute?: string | null;
        linkTargetId?: string | null;
        emailVars?: Record<string, string>;
        emailTemplate?: EmailTemplateId;
      };

    if (!userId || !event || !message) {
      return res.status(400).json({ error: "userId, event, and message required" });
    }

    await dispatchUserNotification(requireSupabaseAdmin(), {
      userId,
      event,
      message,
      linkRoute: linkRoute as Parameters<typeof dispatchUserNotification>[1]["linkRoute"],
      linkTargetId: linkTargetId ?? null,
      emailVars,
      emailTemplateOverride: emailTemplate,
    });

    return res.json({ ok: true });
  });

  app.post("/api/hooks/self-notify", async (req: Request, res: Response) => {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const { event, message, linkRoute, linkTargetId, emailVars, emailTemplate } = req.body as {
      event?: NotificationEvent;
      message?: string;
      linkRoute?: string | null;
      linkTargetId?: string | null;
      emailVars?: Record<string, string>;
      emailTemplate?: EmailTemplateId;
    };

    if (!event || !message) {
      return res.status(400).json({ error: "event and message required" });
    }

    await dispatchUserNotification(requireSupabaseAdmin(), {
      userId: user.id,
      event,
      message,
      linkRoute: linkRoute as Parameters<typeof dispatchUserNotification>[1]["linkRoute"],
      linkTargetId: linkTargetId ?? null,
      emailVars,
      emailTemplateOverride: emailTemplate,
    });

    return res.json({ ok: true });
  });
}
