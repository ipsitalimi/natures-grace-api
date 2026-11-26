import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTransactionalEmail } from "./email/emailService";

type EventRegistrationReceiptOptions = { registrationId: string };

export async function sendEventRegistrationReceipts(
  supabase: SupabaseClient,
  { registrationId }: EventRegistrationReceiptOptions
): Promise<void> {
  const { data: registration, error: registrationError } = await supabase
    .from("event_registrations")
    .select("id, event_id, user_id, attendee_name, attendee_email, attendee_phone, payment_status, amount_paid, razorpay_payment_id")
    .eq("id", registrationId)
    .maybeSingle();

  if (registrationError || !registration || registration.payment_status === "Pending" || registration.payment_status === "Refunded") {
    if (registrationError) console.error("[eventFulfillment] registration lookup failed", registrationError.message);
    return;
  }

  const [{ data: event, error: eventError }, { data: admins }] = await Promise.all([
    supabase.from("events").select("*").eq("id", registration.event_id).maybeSingle(),
    supabase.from("profiles").select("email, full_name").in("role", ["Admin", "admin"]),
  ]);
  if (eventError || !event) {
    console.error("[eventFulfillment] event lookup failed", eventError?.message);
    return;
  }

  const eventValue = (keys: string[], fallback = ""): string => {
    for (const key of keys) {
      const value = (event as Record<string, unknown>)[key];
      if (value !== null && value !== undefined && String(value).trim()) return String(value);
    }
    return fallback;
  };
  const date = eventValue(["date", "event_date", "start_date"]);
  const time = eventValue(["time", "event_time", "start_time"]);
  const location = eventValue(["location", "venue", "event_location"], "See event details in the app");
  const paymentStatus = String(registration.payment_status ?? "None");
  const amount = Number(registration.amount_paid ?? 0);
  const paymentLabel = paymentStatus === "Paid" ? "Paid" : "Free";
  const common = {
    eventTitle: String(event.title ?? "Community event"),
    eventDate: date || "As listed in the app",
    eventTime: time || "As listed in the app",
    eventLocation: location,
    eventDescription: eventValue(["description", "short_description"]),
    attendeeName: String(registration.attendee_name ?? "Attendee"),
    attendeeEmail: String(registration.attendee_email ?? ""),
    attendeePhone: String(registration.attendee_phone ?? ""),
    registrationId: String(registration.id),
    paymentStatus: paymentLabel,
    amountPaid: paymentStatus === "Paid" ? `INR ${amount.toFixed(2)}` : "INR 0.00 (Free)",
    paymentReference: String(registration.razorpay_payment_id ?? "Not applicable"),
  };

  const recipients = [
    { role: "attendee", email: String(registration.attendee_email ?? ""), name: String(registration.attendee_name ?? "there") },
    ...(admins ?? []).map((admin: { email?: string | null; full_name?: string | null }) => ({
      role: "admin",
      email: String(admin.email ?? ""),
      name: String(admin.full_name ?? "Admin"),
    })),
  ];
  const sentTo = new Set<string>();
  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!email || sentTo.has(email)) continue;
    sentTo.add(email);
    const emailHash = crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
    const key = `event-${registrationId}-${recipient.role}-${emailHash}-receipt`;
    const vars = { ...common, name: recipient.name.split(" ")[0] || "there", recipientRole: recipient.role };
    let result: Awaited<ReturnType<typeof sendTransactionalEmail>> = { ok: false, error: "Not attempted" };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      result = await sendTransactionalEmail("event_registration_confirmed", email, vars, key);
      if (result.ok || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
    if (!result.ok || ("skipped" in result && result.skipped)) {
      console.error("[eventFulfillment] event receipt email not delivered", {
        role: recipient.role,
        error: result.ok ? "Email provider skipped" : result.error,
      });
    }
  }
}
