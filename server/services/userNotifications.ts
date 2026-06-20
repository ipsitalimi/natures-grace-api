import type { SupabaseClient } from "@supabase/supabase-js";

export type UserNotificationLinkRoute =
  | "SessionHistory"
  | "SessionDetail"
  | "OrderHistory"
  | "OrderDetail"
  | "Main"
  | "SellerOnboarding"
  | "SellerMain"
  | "PractitionerMain"
  | "ApplicationStatus";

export async function insertUserNotification(
  supabase: SupabaseClient,
  params: {
    userId: string;
    message: string;
    linkRoute?: UserNotificationLinkRoute | null;
    linkTargetId?: string | null;
  }
): Promise<void> {
  const { error } = await supabase.from("notifications").insert({
    user_id: params.userId,
    message: params.message,
    is_read: false,
    link_route: params.linkRoute ?? null,
    link_target_id: params.linkTargetId ?? null,
  });

  if (error) {
    console.error("[userNotifications] insert:", error.message);
  }
}
