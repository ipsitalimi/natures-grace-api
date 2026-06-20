import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_COMMISSION_RATE = 12;

export async function fetchCommissionRate(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase
    .from("platform_settings")
    .select("settings")
    .eq("id", "default")
    .maybeSingle();

  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings;
  const raw = settings?.commissionRate;
  const rate = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : DEFAULT_COMMISSION_RATE;
}

export async function fetchAutoApproveProducts(supabase: SupabaseClient): Promise<boolean> {
  const { data } = await supabase
    .from("platform_settings")
    .select("settings")
    .eq("id", "default")
    .maybeSingle();

  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings;
  return settings?.autoApproveProducts === true;
}
