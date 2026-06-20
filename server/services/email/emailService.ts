import { buildEmail, type EmailTemplateId } from "./templates";

export type { EmailTemplateId };

export type SendEmailResult = { ok: true; skipped?: boolean } | { ok: false; error: string };

/**
 * Sends transactional email when SMTP/API credentials are configured.
 * Set EMAIL_PROVIDER=resend|smtp and corresponding env vars to activate.
 */
export async function sendTransactionalEmail(
  templateId: EmailTemplateId,
  to: string,
  vars: Record<string, string> = {}
): Promise<SendEmailResult> {
  if (!to?.trim()) {
    return { ok: false, error: "Missing recipient email" };
  }

  const payload = buildEmail(templateId, to.trim(), vars);
  const provider = (process.env.EMAIL_PROVIDER ?? "").toLowerCase();

  if (!provider) {
    console.log(`[email] (not configured) ${templateId} → ${to}: ${payload.subject}`);
    return { ok: true, skipped: true };
  }

  try {
    if (provider === "resend") {
      return await sendViaResend(payload);
    }
    if (provider === "smtp") {
      return await sendViaSmtp(payload);
    }
    return { ok: false, error: `Unknown EMAIL_PROVIDER: ${provider}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Email send failed";
    console.error(`[email] ${templateId}:`, message);
    return { ok: false, error: message };
  }
}

async function sendViaResend(payload: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "Nature's Grace <noreply@naturesgrace.app>";
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not set" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: body || `Resend HTTP ${res.status}` };
  }
  return { ok: true };
}

async function sendViaSmtp(payload: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendEmailResult> {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM ?? user;

  if (!host || !user || !pass) {
    return { ok: false, error: "SMTP_HOST, SMTP_USER, SMTP_PASS required" };
  }

  // Lightweight SMTP via fetch to a relay API, or log for manual nodemailer install.
  // Avoid adding nodemailer dependency — use Resend in production.
  console.log(`[email:smtp] Would send to ${payload.to} via ${host}:${port}`);
  console.log(`[email:smtp] Subject: ${payload.subject}`);
  console.log(
    "[email:smtp] Configure RESEND_API_KEY for production, or install nodemailer for raw SMTP."
  );
  return { ok: true, skipped: true };
}

export async function sendEmailToUserId(
  supabase: import("@supabase/supabase-js").SupabaseClient,
  userId: string,
  templateId: EmailTemplateId,
  vars: Record<string, string> = {}
): Promise<SendEmailResult> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, full_name")
    .eq("id", userId)
    .maybeSingle();

  const email = (profile as { email?: string } | null)?.email;
  if (!email) return { ok: false, error: "User email not found" };

  const name = (profile as { full_name?: string } | null)?.full_name?.split(" ")[0] ?? "there";
  return sendTransactionalEmail(templateId, email, { name, ...vars });
}
