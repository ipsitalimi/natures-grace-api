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
export type CheckoutFeeSettings = {
  platformFeeEnabled: boolean;
  platformFeePercent: number;
  platformGstEnabled: boolean;
  platformGstPercent: number;
};

export async function fetchCheckoutFeeSettings(supabase: SupabaseClient): Promise<CheckoutFeeSettings> {
  const { data } = await supabase.from("platform_settings").select("settings").eq("id", "default").maybeSingle();
  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  const validPercent = (value: unknown, fallback: number) => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
  };
  return {
    platformFeeEnabled: settings.platformFeeEnabled === true,
    platformFeePercent: validPercent(settings.platformFeePercent, 0),
    platformGstEnabled: settings.platformGstEnabled === true,
    platformGstPercent: validPercent(settings.platformGstPercent, 18),
  };
}

export function calculateCheckoutTotal(serviceAmountInr: number, settings: CheckoutFeeSettings) {
  const base = Math.round(serviceAmountInr * 100) / 100;
  const platformFee = settings.platformFeeEnabled
    ? Math.round(base * settings.platformFeePercent) / 100
    : 0;
  const platformGst = settings.platformGstEnabled
    ? Math.round(platformFee * settings.platformGstPercent) / 100
    : 0;
  return {
    serviceAmountInr: base,
    platformFeeInr: platformFee,
    platformGstInr: platformGst,
    totalInr: Math.round((base + platformFee + platformGst) * 100) / 100,
  };
}
