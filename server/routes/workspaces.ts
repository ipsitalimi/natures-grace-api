import type { Express, Request, Response } from "express";
import { requireRole } from "../middleware/auth";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";

type WorkspaceRow = {
  id: string;
  workspace_profile_id: string;
  workspace_role: "Admin" | "User" | "Practitioner" | "Seller";
  display_name: string;
  is_default: boolean;
  is_enabled: boolean;
};

export function registerWorkspaceRoutes(app: Express): void {
  app.get("/api/account/workspaces", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const supabase = requireSupabaseAdmin();
    const { data, error } = await supabase
      .from("account_workspaces")
      .select("id, workspace_profile_id, workspace_role, display_name, is_default, is_enabled")
      .eq("owner_user_id", admin.id)
      .order("is_default", { ascending: false })
      .order("display_name", { ascending: true });

    if (error) return res.status(500).json({ error: "Unable to load workspaces" });

    const workspaces = (data ?? []) as WorkspaceRow[];
    const hydrated = await Promise.all(workspaces.map(async (workspace) => {
      if (!workspace.is_enabled) return { ...workspace, available: false };
      if (workspace.workspace_role === "Admin" || workspace.workspace_role === "User") {
        return { ...workspace, available: true };
      }
      if (workspace.workspace_role === "Practitioner") {
        const { data: practitioner } = await supabase
          .from("practitioners")
          .select("id")
          .eq("profile_id", workspace.workspace_profile_id)
          .eq("is_active", true)
          .eq("approval_status", "Approved")
          .maybeSingle();
        return { ...workspace, available: Boolean(practitioner) };
      }
      if (workspace.workspace_role === "Seller") {
        const { data: seller } = await supabase
          .from("sellers")
          .select("id")
          .eq("profile_id", workspace.workspace_profile_id)
          .eq("is_active", true)
          .maybeSingle();
        return { ...workspace, available: Boolean(seller) };
      }
      return { ...workspace, available: false };
    }));

    return res.json({ workspaces: hydrated });
  });

  app.post("/api/account/workspaces/activate", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const workspaceProfileId = String(req.body?.workspace_profile_id ?? "").trim();
    if (!workspaceProfileId) {
      return res.status(400).json({ error: "workspace_profile_id is required" });
    }

    const supabase = requireSupabaseAdmin();
    const { data: workspace, error: workspaceError } = await supabase
      .from("account_workspaces")
      .select("workspace_profile_id, workspace_role, display_name, is_enabled")
      .eq("owner_user_id", admin.id)
      .eq("workspace_profile_id", workspaceProfileId)
      .eq("is_enabled", true)
      .maybeSingle();

    if (workspaceError || !workspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    if (workspace.workspace_role === "Practitioner") {
      const { data } = await supabase
        .from("practitioners")
        .select("id")
        .eq("profile_id", workspaceProfileId)
        .eq("is_active", true)
        .eq("approval_status", "Approved")
        .maybeSingle();
      if (!data) return res.status(403).json({ error: "Practitioner workspace is not active and approved" });
    }

    if (workspace.workspace_role === "Seller") {
      const { data } = await supabase
        .from("sellers")
        .select("id")
        .eq("profile_id", workspaceProfileId)
        .eq("is_active", true)
        .maybeSingle();
      if (!data) return res.status(403).json({ error: "Seller workspace is not set up yet" });
    }

    const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(admin.id);
    if (authError || !authUser.user) {
      return res.status(500).json({ error: "Unable to load account metadata" });
    }

    const existingMetadata = authUser.user.app_metadata ?? {};
    const { error: updateError } = await supabase.auth.admin.updateUserById(admin.id, {
      app_metadata: {
        ...existingMetadata,
        active_workspace_profile_id: workspace.workspace_profile_id,
        active_workspace_role: workspace.workspace_role,
      },
    });

    if (updateError) return res.status(500).json({ error: "Unable to activate workspace" });

    return res.json({
      ok: true,
      workspace: {
        profile_id: workspace.workspace_profile_id,
        role: workspace.workspace_role,
        display_name: workspace.display_name,
      },
      refresh_session_required: true,
    });
  });
}
