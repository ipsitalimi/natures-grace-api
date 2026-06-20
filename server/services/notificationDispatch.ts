import type { SupabaseClient } from "@supabase/supabase-js";
import { insertUserNotification, type UserNotificationLinkRoute } from "./userNotifications";
import { sendEmailToUserId, sendTransactionalEmail, type EmailTemplateId } from "./email/emailService";

export type NotificationCategory =
  | "booking_reminders"
  | "order_updates"
  | "community_activity"
  | "promotions"
  | "platform_announcements";

export type NotificationEvent =
  | "booking_reminder"
  | "booking_confirmed"
  | "booking_cancelled"
  | "order_confirmed"
  | "order_shipped"
  | "order_delivered"
  | "practitioner_approved"
  | "seller_approved"
  | "application_rejected"
  | "refund_approved"
  | "withdrawal_received"
  | "withdrawal_completed"
  | "application_submitted";

const EVENT_CATEGORY: Record<NotificationEvent, NotificationCategory> = {
  booking_reminder: "booking_reminders",
  booking_confirmed: "booking_reminders",
  booking_cancelled: "booking_reminders",
  order_confirmed: "order_updates",
  order_shipped: "order_updates",
  order_delivered: "order_updates",
  practitioner_approved: "platform_announcements",
  seller_approved: "platform_announcements",
  application_rejected: "platform_announcements",
  refund_approved: "order_updates",
  withdrawal_received: "order_updates",
  withdrawal_completed: "order_updates",
  application_submitted: "platform_announcements",
};

const EVENT_EMAIL: Partial<Record<NotificationEvent, EmailTemplateId>> = {
  booking_reminder: "booking_reminder",
  booking_confirmed: "booking_confirmed",
  booking_cancelled: "booking_cancelled",
  order_confirmed: "order_confirmed",
  order_shipped: "order_shipped",
  order_delivered: "order_delivered",
  practitioner_approved: "practitioner_approved",
  seller_approved: "seller_approved",
  application_rejected: "practitioner_rejected",
  refund_approved: "refund_approved",
  withdrawal_received: "withdrawal_received",
  withdrawal_completed: "withdrawal_completed",
};

type ProfilePrefs = {
  notificationsEnabled?: boolean;
  bookingReminders?: boolean;
  orderUpdates?: boolean;
  communityActivity?: boolean;
  promotions?: boolean;
  platformAnnouncements?: boolean;
};

function parsePrefs(raw: unknown): ProfilePrefs {
  if (!raw || typeof raw !== "object") return {};
  return raw as ProfilePrefs;
}

function categoryAllowed(prefs: ProfilePrefs, category: NotificationCategory): boolean {
  if (prefs.notificationsEnabled === false) return false;
  switch (category) {
    case "booking_reminders":
      return prefs.bookingReminders !== false;
    case "order_updates":
      return prefs.orderUpdates !== false;
    case "community_activity":
      return prefs.communityActivity !== false;
    case "promotions":
      return prefs.promotions !== false;
    case "platform_announcements":
      return prefs.platformAnnouncements !== false;
    default:
      return true;
  }
}

export async function dispatchUserNotification(
  supabase: SupabaseClient,
  params: {
    userId: string;
    event: NotificationEvent;
    message: string;
    linkRoute?: UserNotificationLinkRoute | null;
    linkTargetId?: string | null;
    emailVars?: Record<string, string>;
    emailTemplateOverride?: EmailTemplateId;
  }
): Promise<void> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("preferences, email, full_name")
    .eq("id", params.userId)
    .maybeSingle();

  const prefs = parsePrefs((profile as { preferences?: unknown } | null)?.preferences);
  const category = EVENT_CATEGORY[params.event];

  if (categoryAllowed(prefs, category)) {
    await insertUserNotification(supabase, {
      userId: params.userId,
      message: params.message,
      linkRoute: params.linkRoute ?? null,
      linkTargetId: params.linkTargetId ?? null,
    });
  }

  const emailTemplate =
    params.emailTemplateOverride ?? EVENT_EMAIL[params.event];
  if (emailTemplate && categoryAllowed(prefs, category)) {
    await sendEmailToUserId(supabase, params.userId, emailTemplate, params.emailVars ?? {});
  }

  // Push: stored for client poll or future Expo push server integration
  const { data: tokens } = await supabase
    .from("push_tokens")
    .select("token, platform")
    .eq("user_id", params.userId);

  if (tokens?.length && process.env.EXPO_ACCESS_TOKEN && categoryAllowed(prefs, category)) {
    for (const row of tokens as { token: string; platform: string }[]) {
      try {
        await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}`,
          },
          body: JSON.stringify({
            to: row.token,
            title: "Nature's Grace",
            body: params.message,
            data: {
              linkRoute: params.linkRoute,
              linkTargetId: params.linkTargetId,
            },
          }),
        });
      } catch (err) {
        console.warn("[push] send failed:", err);
      }
    }
  }
}

export { sendTransactionalEmail };
