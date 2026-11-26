export type EmailTemplateId =
  | "account_created"
  | "email_verified"
  | "password_changed"
  | "password_reset_requested"
  | "booking_confirmed"
  | "event_registration_confirmed"
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
  | "booking_payment_reconciliation_admin"
  | "booking_refund_request_admin"
  | "booking_refund_approved_manual"
  | "refund_paid"
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}

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
  // Escape all user/database-supplied values before HTML interpolation.
  const safeVars = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, escapeHtml(value)]));
  const name = safeVars.name || "there";
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
      body: `<p>Hi ${escapeHtml(name)},</p><p>Your Nature&#39;s Grace session is confirmed.</p><p><strong>Booking:</strong> ${escapeHtml(safeVars.bookingNumber ?? "")}<br/><strong>Customer:</strong> ${escapeHtml(safeVars.customer ?? "")}<br/><strong>Practitioner:</strong> ${escapeHtml(safeVars.practitioner ?? "")}<br/><strong>Service:</strong> ${escapeHtml(safeVars.service ?? "")}<br/><strong>Date:</strong> ${escapeHtml(safeVars.date ?? "")}<br/><strong>Time:</strong> ${escapeHtml(safeVars.time ?? "")} (IST)<br/><strong>Duration:</strong> ${escapeHtml(safeVars.duration ?? "")} minutes</p><p><strong>Session amount:</strong> ${escapeHtml(safeVars.serviceAmount ?? "")}<br/><strong>Platform fee:</strong> ${escapeHtml(safeVars.platformFee ?? "")}<br/><strong>GST:</strong> ${escapeHtml(safeVars.platformGst ?? "")}<br/><strong>Total paid:</strong> ${escapeHtml(safeVars.totalPaid ?? "")}<br/><strong>Payment reference:</strong> ${escapeHtml(safeVars.paymentId ?? "")}</p>${safeVars.meetingLink ? `<p><a href="${escapeHtml(safeVars.meetingLink)}">Join Google Meet</a></p><p>${escapeHtml(safeVars.meetingLink)}</p>` : `<p>Your Meet link is being prepared. Check your booking in the app before the session.</p>`}`,
    },
    event_registration_confirmed: {
      subject: `Community event registration confirmed: ${safeVars.eventTitle ?? "Event"}`,
      body: `<p>Hi ${name},</p><p>Your registration for the Nature&#39;s Grace community event is confirmed.</p><p><strong>Event:</strong> ${safeVars.eventTitle ?? ""}<br/><strong>Date:</strong> ${safeVars.eventDate ?? ""}<br/><strong>Time:</strong> ${safeVars.eventTime ?? ""} (IST)<br/><strong>Location:</strong> ${safeVars.eventLocation ?? ""}</p>${safeVars.eventDescription ? `<p>${safeVars.eventDescription}</p>` : ""}<p><strong>Attendee:</strong> ${safeVars.attendeeName ?? ""}<br/><strong>Email:</strong> ${safeVars.attendeeEmail ?? ""}<br/><strong>Phone:</strong> ${safeVars.attendeePhone ?? ""}<br/><strong>Registration ID:</strong> ${safeVars.registrationId ?? ""}</p><p><strong>Payment:</strong> ${safeVars.paymentStatus ?? ""}<br/><strong>Amount:</strong> ${safeVars.amountPaid ?? ""}<br/><strong>Payment reference:</strong> ${safeVars.paymentReference ?? "Not applicable"}</p><p>${safeVars.recipientRole === "admin" ? "A participant has registered for this event." : "Thank you for joining our community."}</p>`,
    },
    booking_cancelled: {
      subject: "Session booking cancelled",
      body: `<p>Hi ${name},</p><p>Your session scheduled for ${safeVars.date ?? ""} at ${safeVars.time ?? ""} has been cancelled.</p><p>${safeVars.refundNote ?? "Refund eligibility depends on our cancellation policy."}</p>`,
    },
    booking_reminder: {
      subject: "Reminder: upcoming session",
      body: `<p>Hi ${name},</p><p>This is a reminder for your session with <strong>${safeVars.practitioner ?? ""}</strong> on ${safeVars.date ?? ""} at ${safeVars.time ?? ""}.</p>`,
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
      body: `<p>Hi ${name},</p><p>Thank you for applying. We were unable to approve your application at this time.</p><p><strong>Reason:</strong> ${safeVars.reason ?? "Please contact support for details."}</p><p>You may reapply with updated information from the app.</p>`,
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
      body: `<p>Hi ${name},</p><p>We were unable to approve your seller application at this time.</p><p><strong>Reason:</strong> ${safeVars.reason ?? "Please contact support for details."}</p><p>You may reapply with updated information from the app.</p>`,
    },
    order_confirmed: {
      subject: `Order ${safeVars.orderNumber ?? ""} confirmed`,
      body: `<p>Hi ${name},</p><p>Thank you for your order <strong>${safeVars.orderNumber ?? ""}</strong>.</p><p><strong>Total:</strong> ${safeVars.total ?? ""}</p><p>We'll notify you when your order ships.</p>`,
    },
    order_cancelled: {
      subject: `Order ${safeVars.orderNumber ?? ""} cancelled`,
      body: `<p>Hi ${name},</p><p>Your order <strong>${safeVars.orderNumber ?? ""}</strong> has been cancelled.</p><p>${safeVars.refundNote ?? ""}</p>`,
    },
    order_shipped: {
      subject: `Order ${safeVars.orderNumber ?? ""} shipped`,
      body: `<p>Hi ${name},</p><p>Your order has been shipped.</p><p><strong>Courier:</strong> ${safeVars.courier ?? "—"}<br/><strong>Tracking:</strong> ${safeVars.tracking ?? "—"}</p>`,
    },
    order_delivered: {
      subject: `Order ${safeVars.orderNumber ?? ""} delivered`,
      body: `<p>Hi ${name},</p><p>Your order <strong>${safeVars.orderNumber ?? ""}</strong> has been delivered. We hope you enjoy your purchase.</p>`,
    },
    refund_approved: {
      subject: "Refund approved",
      body: `<p>Hi ${name},</p><p>Your refund request has been approved.</p><p><strong>Amount:</strong> ${safeVars.amount ?? ""}<br/><strong>Reference:</strong> ${safeVars.reference ?? ""}</p><p>Funds may take 5–10 business days to appear depending on your bank.</p>`,
    },
    booking_refund_approved_manual: {
      subject: "Your booking refund has been approved",
      body: `<p>Hi ${name},</p><p>Your practitioner-session refund request has been approved. Nature's Grace will arrange the bank transfer manually and notify you once it has been sent.</p><p><strong>Amount:</strong> ${safeVars.amount ?? ""}<br/><strong>Request reference:</strong> ${safeVars.reference ?? ""}</p>`,
    },
    refund_paid: {
      subject: "Your refund bank transfer has been recorded",
      body: `<p>Hi ${name},</p><p>Nature's Grace has recorded your manual bank transfer.</p><p><strong>Amount:</strong> ${safeVars.amount ?? ""}<br/><strong>Bank transfer reference:</strong> ${safeVars.reference ?? ""}</p><p>Please allow your bank's normal processing time for the funds to appear.</p>`,
    },
    booking_payment_reconciliation_admin: {
      subject: `URGENT: Captured booking payment needs review — ${safeVars.orderId ?? "Razorpay order"}`,
      body: `<p>A Razorpay payment was captured, but the selected practitioner session could not be confirmed automatically.</p><p><strong>Order:</strong> ${safeVars.orderId ?? ""}<br/><strong>Payment:</strong> ${safeVars.paymentId ?? ""}<br/><strong>Customer:</strong> ${safeVars.customerId ?? ""}<br/><strong>Practitioner:</strong> ${safeVars.practitionerId ?? ""}<br/><strong>Session:</strong> ${safeVars.sessionDate ?? ""} at ${safeVars.sessionTime ?? ""} IST<br/><strong>Reason:</strong> ${safeVars.reason ?? "Slot conflict"}</p><p>Review the booking payment reconciliation queue. Do not ask the customer to pay again. Arrange a confirmed alternative session or process the appropriate refund manually.</p>`,
    },
    booking_refund_request_admin: {
      subject: `Manual booking refund requires review — ${safeVars.bookingNumber ?? "Booking"}`,
      body: `<p>A customer has cancelled a practitioner session and a manual refund requires review.</p><p><strong>Booking:</strong> ${safeVars.bookingNumber ?? ""}<br/><strong>Refund request:</strong> ${safeVars.refundRequestId ?? ""}<br/><strong>Customer:</strong> ${safeVars.customerName ?? ""}<br/><strong>Customer email:</strong> ${safeVars.customerEmail ?? ""}<br/><strong>Practitioner:</strong> ${safeVars.practitionerName ?? ""}<br/><strong>Service:</strong> ${safeVars.serviceName ?? ""}<br/><strong>Session:</strong> ${safeVars.sessionDate ?? ""} at ${safeVars.sessionTime ?? ""} IST<br/><strong>Duration:</strong> ${safeVars.durationMinutes ?? ""} minutes<br/><strong>Refund to review:</strong> ${safeVars.refundAmount ?? ""}</p><p><strong>Customer's cancellation note:</strong> ${safeVars.cancellationNote ?? "Not provided"}</p><p>Review this request in the admin panel. If approved, arrange the bank transfer manually and record the transfer reference after payment. No payment is initiated by this email or the admin approval action.</p>`,
    },
    withdrawal_received: {
      subject: "Withdrawal request received",
      body: `<p>Hi ${name},</p><p>We received your withdrawal request for <strong>${safeVars.amount ?? ""}</strong>.</p><p>Requests are processed manually by our team within 3–7 business days.</p>`,
    },
    withdrawal_completed: {
      subject: "Withdrawal completed",
      body: `<p>Hi ${name},</p><p>Your withdrawal of <strong>${safeVars.amount ?? ""}</strong> has been processed and sent to your registered bank account.</p>`,
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
