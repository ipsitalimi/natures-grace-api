import { resolveSupabaseProjectUrl } from "./supabaseAdmin";

export function assertServerProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const missing: string[] = [];
  if (!resolveSupabaseProjectUrl()) missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!process.env.RAZORPAY_KEY_ID?.trim()) {
    missing.push("RAZORPAY_KEY_ID");
  }
  if (!process.env.RAZORPAY_KEY_SECRET?.trim()) {
    missing.push("RAZORPAY_KEY_SECRET");
  }
  if (!process.env.RAZORPAY_WEBHOOK_SECRET?.trim()) {
    missing.push("RAZORPAY_WEBHOOK_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(
      `Production server missing required environment variables: ${missing.join(", ")}`
    );
  }
}
