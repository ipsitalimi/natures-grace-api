import { createClient, SupabaseClient } from "@supabase/supabase-js";

let adminClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url?.trim() || !serviceKey?.trim()) {
    return null;
  }

  if (!adminClient) {
    adminClient = createClient(url.trim(), serviceKey.trim(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return adminClient;
}

export function requireSupabaseAdmin(): SupabaseClient {
  const client = getSupabaseAdmin();
  if (!client) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL are required for payout webhooks"
    );
  }
  return client;
}
