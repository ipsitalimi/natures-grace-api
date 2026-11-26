import type { Request, Response } from "express";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";

export type AuthUser = { id: string; email?: string; authUserId?: string };

export type AuthProfile = {
  id: string;
  authUserId: string;
  email: string;
  role: string;
  status?: string | null;
};

async function getVerifiedAuthUser(req: Request) {
  const authHeader = req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const supabase = requireSupabaseAdmin();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

/** The immutable Supabase identity. Use for account-level operations only. */
export async function getBearerUser(req: Request): Promise<AuthUser | null> {
  const user = await getVerifiedAuthUser(req);
  return user ? { id: user.id, email: user.email } : null;
}

/** Resolve the selected profile only after validating its server-managed workspace mapping. */
export async function getBearerProfile(req: Request): Promise<AuthProfile | null> {
  const user = await getVerifiedAuthUser(req);
  if (!user) return null;

  const supabase = requireSupabaseAdmin();
  const requestedWorkspaceId = String(
    user.app_metadata?.active_workspace_profile_id ?? ""
  ).trim();

  let profileId = user.id;
  if (requestedWorkspaceId) {
    const { data: mapping, error: mappingError } = await supabase
      .from("account_workspaces")
      .select("workspace_profile_id, workspace_role")
      .eq("owner_user_id", user.id)
      .eq("workspace_profile_id", requestedWorkspaceId)
      .eq("is_enabled", true)
      .maybeSingle();

    if (mappingError || !mapping) return null;
    profileId = mapping.workspace_profile_id;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, role, status")
    .eq("id", profileId)
    .maybeSingle();

  if (error || !data) return null;
  if (requestedWorkspaceId) {
    const { data: mapping } = await supabase
      .from("account_workspaces")
      .select("workspace_role")
      .eq("owner_user_id", user.id)
      .eq("workspace_profile_id", profileId)
      .eq("is_enabled", true)
      .maybeSingle();
    if (!mapping || mapping.workspace_role !== data.role) return null;
  }

  return { ...(data as Omit<AuthProfile, "authUserId">), authUserId: user.id };
}

/** Allows the master account to list/switch its mapped workspaces regardless of active role. */
export async function requireMasterAccount(
  req: Request,
  res: Response
): Promise<AuthProfile | null> {
  const user = await getVerifiedAuthUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const supabase = requireSupabaseAdmin();
  const { data: masterProfile, error } = await supabase
    .from("profiles")
    .select("id, email, role, status")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !masterProfile || masterProfile.role !== "Admin") {
    res.status(403).json({ error: "Master account required" });
    return null;
  }

  if (["Suspended", "Deletion Requested", "Deleted"].includes(masterProfile.status ?? "")) {
    res.status(403).json({ error: "Account is not active" });
    return null;
  }

  return { ...masterProfile, authUserId: user.id } as AuthProfile;
}

export async function requireBearerUser(
  req: Request,
  res: Response
): Promise<AuthUser | null> {
  const profile = await getBearerProfile(req);
  if (!profile) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (["Suspended", "Deletion Requested", "Deleted"].includes(profile.status ?? "")) {
    res.status(403).json({ error: "Account is not active" });
    return null;
  }
  return { id: profile.id, email: profile.email, authUserId: profile.authUserId };
}

export async function requireRole(
  req: Request,
  res: Response,
  role: string
): Promise<AuthProfile | null> {
  const profile = await getBearerProfile(req);
  if (!profile) {
    res.status(401).json({ error: "Unauthorized or workspace unavailable" });
    return null;
  }
  if (["Suspended", "Deletion Requested", "Deleted"].includes(profile.status ?? "")) {
    res.status(403).json({ error: "Account is not active" });
    return null;
  }
  if (profile.role !== role) {
    res.status(403).json({ error: "Forbidden for the active workspace" });
    return null;
  }
  return profile;
}
