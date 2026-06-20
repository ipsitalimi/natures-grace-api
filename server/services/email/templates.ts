export type EmailTemplateId =
  | "account_created"
  | "email_verified"
  | "password_changed"
  | "password_reset_requested"
  | "booking_confirmed"
  | "booking_cancelled"
  | "booking_reminder"
  | "practitioner_application_submitted"
  | "practitioner_approved"
  | "practitioner_rejected"
  | "seller_application_submitted"
  | "seller_approved"
  | "seller_rejected"
  | "order_confirmed"
  | "order_cancelled"
  | "order_shipped"
  | "order_delivered"
  | "refund_approved"
  | "withdrawal_received"
  | "withdrawal_completed"
  | "account_deletion_requested";

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const BRAND = "Nature's Grace";

function wrap(body: string): string {
  return `<!DOCTYPE html><html><body style="font-family:Georgia,serif;color:#1a1a1a;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;">
<p style="color:#013220;font-weight:bold;font-size:18px;">${BRAND}</p>
${body}
<p style="color:#888;font-size:12px;margin-top:32px;">This is an automated message from ${BRAND}. Please do not reply directly to this email.</p>
</body></html>`;
}

export function buildEmail(
  templateId: EmailTemplateId,
  to: string,
  vars: Record<string, string>
): EmailPayload {
  const name = vars.name || "there";
  const templates: Record<EmailTemplateId, { subject: string; body: string }> = {
    account_created: {
      subject: `Welcome to ${BRAND}`,
      body: `<p>Hi ${name},</p><p>Your account has been created. We're glad you're here.</p><p>Complete your profile and explore wellness, community, and our store.</p>`,
    },
    email_verified: {
      subject: "Your email is verified",
      body: `<p>Hi ${name},</p><p>Your email address has been verified. Your account is fully active.</p>`,
    },
    password_changed: {
      subject: "Your password was changed",
      body: `<p>Hi ${name},</p><p>Your password was changed successfully. If you did not make this change, contact support immediately.</p>`,
    },
    password_reset_requested: {
      subject: "Reset your password",
      body: `<p>Hi ${name},</p><p>We received a request to reset your password. Use the link in the app or email we sent to choose a new password.</p>`,
    },
    booking_confirmed: {
      subject: "Session booking confirmed",
      body: `<p>Hi ${name},</p><p>Your session with <strong>${vars.practitioner ?? "your practitioner"}</strong> is confirmed.</p><p><strong>Date:</strong> ${vars.date ?? ""}<br/><strong>Time:</strong> ${vars.time ?? ""}<br/><strong>Service:</strong> ${vars.service ?? ""}</p>`,
    },
    booking_cancelled: {
      subject: "Session booking cancelled",
      body: `<p>Hi ${name},</p><p>Your session scheduled for ${vars.date ?? ""} at ${vars.time ?? ""} has been cancelled.</p><p>${vars.refundNote ?? "Refund eligibility depends on our cancellation policy."}</p>`,
    },
    booking_reminder: {
      subject: "Reminder: upcoming session",
      body: `<p>Hi ${name},</p><p>This is a reminder for your session with <strong>${vars.practitioner ?? ""}</strong> on ${vars.date ?? ""} at ${vars.time ?? ""}.</p>`,
    },
    practitioner_application_submitted: {
      subject: "Practitioner application received",
      body: `<p>Hi ${name},</p><p>We've received your practitioner application. Our team typically reviews applications within 5–7 business days.</p>`,
    },
    practitioner_approved: {
      subject: "Practitioner application approved",
      body: `<p>Hi ${name},</p><p>Congratulations! Your practitioner application has been approved. Sign in to access your practitioner dashboard.</p>`,
    },
    practitioner_rejected: {
      subject: "Practitioner application update",
      body: `<p>Hi ${name},</p><p>Thank you for applying. We were unable to approve your application at this time.</p><p><strong>Reason:</strong> ${vars.reason ?? "Please contact support for details."}</p><p>You may reapply with updated information from the app.</p>`,
    },
    seller_application_submitted: {
      subject: "Seller application received",
      body: `<p>Hi ${name},</p><p>We've received your seller application. Our team typically reviews applications within 5–7 business days.</p>`,
    },
    seller_approved: {
      subject: "Seller application approved",
      body: `<p>Hi ${name},</p><p>Your seller application has been approved. Sign in to list products and manage your store.</p>`,
    },
    seller_rejected: {
      subject: "Seller application update",
      body: `<p>Hi ${name},</p><p>We were unable to approve your seller application at this time.</p><p><strong>Reason:</strong> ${vars.reason ?? "Please contact support for details."}</p><p>You may reapply with updated information from the app.</p>`,
    },
    order_confirmed: {
      subject: `Order ${vars.orderNumber ?? ""} confirmed`,
      body: `<p>Hi ${name},</p><p>Thank you for your order <strong>${vars.orderNumber ?? ""}</strong>.</p><p><strong>Total:</strong> ${vars.total ?? ""}</p><p>We'll notify you when your order ships.</p>`,
    },
    order_cancelled: {
      subject: `Order ${vars.orderNumber ?? ""} cancelled`,
      body: `<p>Hi ${name},</p><p>Your order <strong>${vars.orderNumber ?? ""}</strong> has been cancelled.</p><p>${vars.refundNote ?? ""}</p>`,
    },
    order_shipped: {
      subject: `Order ${vars.orderNumber ?? ""} shipped`,
      body: `<p>Hi ${name},</p><p>Your order has been shipped.</p><p><strong>Courier:</strong> ${vars.courier ?? "—"}<br/><strong>Tracking:</strong> ${vars.tracking ?? "—"}</p>`,
    },
    order_delivered: {
      subject: `Order ${vars.orderNumber ?? ""} delivered`,
      body: `<p>Hi ${name},</p><p>Your order <strong>${vars.orderNumber ?? ""}</strong> has been delivered. We hope you enjoy your purchase.</p>`,
    },
    refund_approved: {
      subject: "Refund approved",
      body: `<p>Hi ${name},</p><p>Your refund request has been approved.</p><p><strong>Amount:</strong> ${vars.amount ?? ""}<br/><strong>Reference:</strong> ${vars.reference ?? ""}</p><p>Funds may take 5–10 business days to appear depending on your bank.</p>`,
    },
    withdrawal_received: {
      subject: "Withdrawal request received",
      body: `<p>Hi ${name},</p><p>We received your withdrawal request for <strong>${vars.amount ?? ""}</strong>.</p><p>Requests are processed manually by our team within 3–7 business days.</p>`,
    },
    withdrawal_completed: {
      subject: "Withdrawal completed",
      body: `<p>Hi ${name},</p><p>Your withdrawal of <strong>${vars.amount ?? ""}</strong> has been processed and sent to your registered bank account.</p>`,
    },
    account_deletion_requested: {
      subject: "Account deletion request received",
      body: `<p>Hi ${name},</p><p>We received your request to delete your ${BRAND} account.</p><p>Pending orders, payouts, or legal holds may delay processing. We will email you when deletion is complete.</p>`,
    },
  };

  const t = templates[templateId];
  const html = wrap(t.body);
  const text = t.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { to, subject: t.subject, html, text };
}
