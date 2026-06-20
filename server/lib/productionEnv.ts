export function assertServerProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const missing: string[] = [];
  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() ?? process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!process.env.RAZORPAY_KEY_ID?.trim() && !process.env.RAZORPAYX_KEY_ID?.trim()) {
    missing.push("RAZORPAY_KEY_ID");
  }
  if (!process.env.RAZORPAY_KEY_SECRET?.trim() && !process.env.RAZORPAYX_KEY_SECRET?.trim()) {
    missing.push("RAZORPAY_KEY_SECRET");
  }
  if (
    !process.env.RAZORPAY_WEBHOOK_SECRET?.trim() &&
    !process.env.RAZORPAYX_WEBHOOK_SECRET?.trim()
  ) {
    missing.push("RAZORPAY_WEBHOOK_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(
      `Production server missing required environment variables: ${missing.join(", ")}`
    );
  }
}
