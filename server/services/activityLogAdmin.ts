import type { SupabaseClient } from "@supabase/supabase-js";

export async function insertActivityLog(
  supabase: SupabaseClient,
  params: {
    actorId: string;
    actorName: string;
    actionType: "booking" | "user" | "review" | "event" | "store" | "settings";
    description: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await supabase.from("activity_log").insert({
    actor_id: params.actorId,
    actor_name: params.actorName,
    action_type: params.actionType,
    description: params.description,
    target_type: params.targetType ?? null,
    target_id: params.targetId ?? null,
    metadata: params.metadata ?? {},
  });
  if (error) console.error("[activityLogAdmin] insert:", error.message);
}
