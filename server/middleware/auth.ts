import type { Request, Response } from "express";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";

export type AuthUser = { id: string; email?: string };

export type AuthProfile = {
  id: string;
  email: string;
  role: string;
};

export async function getBearerUser(req: Request): Promise<AuthUser | null> {
  const authHeader = req.header("authorization");
  console.log("[auth][booking] authorization header present:", Boolean(authHeader));
  if (!authHeader?.startsWith("Bearer ")) {
    console.warn("[auth][booking] 401 reason: missing or malformed Bearer header");
    return null;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    console.warn("[auth][booking] 401 reason: empty Bearer token");
    return null;
  }

  const supabase = requireSupabaseAdmin();
  try {
    console.log("[auth][booking] verifying JWT with Supabase");
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      console.warn("[auth][booking] JWT verification failed:", {
        reason: error?.message ?? "no user",
        status: error?.status,
      });
      return null;
    }

    console.log("[auth][booking] JWT verification succeeded:", {
      userId: data.user.id,
      emailPresent: Boolean(data.user.email),
    });
    return { id: data.user.id, email: data.user.email };
  } catch (err) {
    console.error("[auth][booking] JWT verification threw:", err);
    if (err instanceof Error) {
      console.error("[auth][booking] JWT verification stack:", err.stack);
    }
    throw err;
  }
}

export async function getBearerProfile(req: Request): Promise<AuthProfile | null> {
  const user = await getBearerUser(req);
  if (!user) return null;

  const supabase = requireSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data) return null;
  return data as AuthProfile;
}

export async function requireBearerUser(
  req: Request,
  res: Response
): Promise<AuthUser | null> {
  const user = await getBearerUser(req);
  if (!user) {
    console.warn("[auth][booking] sending 401 Unauthorized");
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return user;
}

export async function requireRole(
  req: Request,
  res: Response,
  role: string
): Promise<AuthProfile | null> {
  const profile = await getBearerProfile(req);
  if (!profile) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (profile.role !== role) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return profile;
}
