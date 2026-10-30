import { createClient, SupabaseClient } from "@supabase/supabase-js";

let adminClient: SupabaseClient | null = null;

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Accept full https URL or bare project ref (e.g. eloqkokldvxyatqhrojc). */
export function resolveSupabaseProjectUrl(): string | null {
  const candidates = [
    readTrimmedEnv("SUPABASE_URL"),
    readTrimmedEnv("EXPO_PUBLIC_SUPABASE_URL"),
  ].filter(Boolean) as string[];

  for (const raw of candidates) {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return raw.replace(/\/$/, "");
    }
    if (/^[a-z0-9-]+$/i.test(raw)) {
      return `https://${raw}.supabase.co`;
    }
  }
  return null;
}

export function getSupabaseAdmin(): SupabaseClient | null {
  const url = resolveSupabaseProjectUrl();
  const serviceKey = readTrimmedEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceKey) {
    return null;
  }

  if (!adminClient) {
    adminClient = createClient(url, serviceKey, {
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
