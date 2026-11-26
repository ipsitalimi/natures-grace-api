import type { Express, Request, Response } from "express";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireRole } from "../middleware/auth";
import { dispatchUserNotification } from "../services/notificationDispatch";
import { sendEmailToUserId } from "../services/email/emailService";
import { insertActivityLog } from "../services/activityLogAdmin";
import { createRazorpayRefund } from "../services/razorpayRefund";
import { reverseOrderEarning } from "../services/sellerWalletLedger";
import { reverseBookingEarning, reverseBookingEarningForRefund } from "../services/practitionerWalletLedger";
import { calculateBookingRefund, fetchBookingCancellationPolicy } from "../services/bookingCancellationPolicy";
import { fetchCommissionRate } from "../services/platformSettings";
import {
  restoreOrderStock,
  restorePromoUsageOnRefund,
} from "../services/orderFulfillment";

type PayoutStatus = "Pending" | "Under Review" | "Processing" | "Completed" | "Rejected";

async function updateSellerPayoutStatus(
  payoutId: string,
  status: PayoutStatus,
  adminId: string,
  rejectionReason?: string
) {
  const supabase = requireSupabaseAdmin();
  const { data: payout, error: fetchError } = await supabase
    .from("seller_payouts")
    .select("amount, seller_wallets(sellers(profile_id))")
    .eq("id", payoutId)
    .maybeSingle();
  if (fetchError) return { error: fetchError.message };
  if (!payout) return { error: "Payout not found" };

  const { data, error } = await supabase.rpc("admin_update_payout_status", {
    p_payout_type: "seller", p_payout_id: payoutId, p_status: status,
    p_admin_id: adminId, p_rejection_reason: rejectionReason ?? null,
  });
  if (error) return { error: error.message };
  const result = data as { ok?: boolean; error?: string } | null;
  if (!result?.ok) return { error: result?.error ?? "Could not update payout status" };

  const profileId = (payout as { seller_wallets?: { sellers?: { profile_id?: string } } })
    .seller_wallets?.sellers?.profile_id ?? null;
  if (profileId) {
    const amountStr = `₹${Number((payout as { amount: number }).amount).toLocaleString("en-IN")}`;
    if (status === "Completed") await dispatchUserNotification(supabase, {
      userId: profileId, event: "withdrawal_completed",
      message: `Your withdrawal of ${amountStr} has been completed.`, linkRoute: "Main",
    });
    else if (status === "Rejected") await dispatchUserNotification(supabase, {
      userId: profileId, event: "withdrawal_received",
      message: "Your withdrawal request was not approved. Funds returned to your wallet.", linkRoute: "Main",
    });
  }
  return { ok: true };
}

async function updatePractitionerPayoutStatus(
  payoutId: string,
  status: PayoutStatus,
  adminId: string,
  rejectionReason?: string
) {
  const supabase = requireSupabaseAdmin();
  const { data: payout, error: fetchError } = await supabase
    .from("practitioner_payouts")
    .select("amount, practitioner_wallets(practitioners(profile_id))")
    .eq("id", payoutId)
    .maybeSingle();
  if (fetchError) return { error: fetchError.message };
  if (!payout) return { error: "Payout not found" };

  const { data, error } = await supabase.rpc("admin_update_payout_status", {
    p_payout_type: "practitioner", p_payout_id: payoutId, p_status: status,
    p_admin_id: adminId, p_rejection_reason: rejectionReason ?? null,
  });
  if (error) return { error: error.message };
  const result = data as { ok?: boolean; error?: string } | null;
  if (!result?.ok) return { error: result?.error ?? "Could not update payout status" };

  const profileId = (payout as { practitioner_wallets?: { practitioners?: { profile_id?: string } } })
    .practitioner_wallets?.practitioners?.profile_id ?? null;
  if (profileId && status === "Completed") {
    const amountStr = `₹${Number((payout as { amount: number }).amount).toLocaleString("en-IN")}`;
    await dispatchUserNotification(supabase, {
      userId: profileId, event: "withdrawal_completed",
      message: `Your withdrawal of ${amountStr} has been completed.`, linkRoute: "Main",
    });
  }
  return { ok: true };
}

export function registerAdminOperationsRoutes(app: Express) {

  app.get("/api/admin/booking-payment-reconciliation", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;
    const { data, error } = await requireSupabaseAdmin()
      .from("booking_payment_reconciliation")
      .select("*")
      .eq("status", "needs_admin_review")
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ items: data ?? [] });
  });


  app.get("/api/admin/payouts", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const supabase = requireSupabaseAdmin();
    const [sellerPayouts, practitionerPayouts] = await Promise.all([
      supabase
        .from("seller_payouts")
        .select("*, seller_wallets(seller_id, sellers(store_name, profile_id))")
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("practitioner_payouts")
        .select("*, practitioner_wallets(practitioner_id, practitioners(name, profile_id))")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    return res.json({
      seller: sellerPayouts.data ?? [],
      practitioner: practitionerPayouts.data ?? [],
    });
  });

  app.post("/api/admin/payouts/:type/:id/status", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const typeParam = String(Array.isArray(req.params.type) ? req.params.type[0] : req.params.type);
    const payoutId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const { status, rejectionReason } = req.body as {
      status: PayoutStatus;
      rejectionReason?: string;
    };

    const allowed: PayoutStatus[] = ["Under Review", "Processing", "Completed", "Rejected"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const result =
      typeParam === "seller"
        ? await updateSellerPayoutStatus(payoutId, status, admin.id, rejectionReason)
        : typeParam === "practitioner"
          ? await updatePractitionerPayoutStatus(payoutId, status, admin.id, rejectionReason)
          : { error: "Invalid type" };

    if ("error" in result && result.error) {
      return res.status(400).json(result);
    }

    await insertActivityLog(requireSupabaseAdmin(), {
      actorId: admin.id,
      actorName: admin.email,
      actionType: "settings",
      description: `Payout ${payoutId} marked ${status}`,
      targetType: "payout",
      targetId: payoutId,
    });

    return res.json({ ok: true });
  });

  app.get("/api/admin/refunds", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const { data, error } = await requireSupabaseAdmin()
      .from("refund_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ refunds: data ?? [] });
  });

  app.post("/api/admin/refunds/:id/status", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const body = req.body as { status?: unknown; adminNotes?: unknown };
    const status = body.status;
    const allowedRefundStatuses = ["in_review", "approved", "rejected"] as const;
    if (typeof status !== "string" || !allowedRefundStatuses.includes(status as typeof allowedRefundStatuses[number])) {
      return res.status(400).json({ error: "Invalid refund status" });
    }
    if (body.adminNotes !== undefined && body.adminNotes !== null && typeof body.adminNotes !== "string") {
      return res.status(400).json({ error: "Admin notes must be text" });
    }
    const adminNotes = typeof body.adminNotes === "string" ? body.adminNotes.trim().slice(0, 2000) : null;
    const refundId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    if (!refundId) return res.status(400).json({ error: "Refund request id is required" });
    const supabase = requireSupabaseAdmin();

    const { data: existing, error: fetchError } = await supabase
      .from("refund_requests")
      .select("*")
      .eq("id", refundId)
      .maybeSingle();

    if (fetchError || !existing) {
      return res.status(404).json({ error: "Refund request not found" });
    }

    const existingStatus = String((existing as { status: string }).status);
    if (existingStatus === "approved" || existingStatus === "rejected" || existingStatus === "paid") {
      return res.status(409).json({ error: `Refund already ${existingStatus}` });
    }

    // Keep the existing processing claim only for store-order refunds.
    // Practitioner booking refunds are approved for a later manual bank transfer.
    const isStoreOrderRefund = Boolean((existing as { order_id?: string | null }).order_id);
    if (status === "approved" && isStoreOrderRefund) {
      if ((existing as { processing_started_at?: string | null }).processing_started_at) {
        return res.status(409).json({ error: "Refund approval was already started. Refresh the request before retrying." });
      }
      const { data: claimed, error: claimError } = await supabase.from("refund_requests")
        .update({ processing_started_at: new Date().toISOString() })
        .eq("id", refundId).is("processing_started_at", null)
        .not("status", "in", '("approved","rejected","paid")').select("id").maybeSingle();
      if (claimError || !claimed) {
        return res.status(409).json({ error: "Refund is already being processed or requires reconciliation." });
      }
    }
    const userId = (existing as { user_id: string }).user_id;
    const orderId = (existing as { order_id?: string | null }).order_id;
    const bookingId = (existing as { booking_id?: string | null }).booking_id;

    if (status === "approved") {
      const commissionRate = await fetchCommissionRate(supabase);
      let refundError: string | undefined;

      if (orderId) {
        const { data: order } = await supabase
          .from("orders")
          .select(
            "id, order_number, seller_id, status, payment_status, total, razorpay_payment_id, seller_promo_id, platform_promo_id"
          )
          .eq("id", orderId)
          .maybeSingle();

        if (!order) {
          refundError = "Order not found";
        } else if (!order.razorpay_payment_id) {
          refundError = "Order has no Razorpay payment ID — process refund manually";
        } else {
          const razorpayRefund = await createRazorpayRefund({
            paymentId: order.razorpay_payment_id as string,
            amountInr: Number(order.total),
            notes: { refund_request_id: refundId },
          });
          if (!razorpayRefund.ok) {
            refundError = razorpayRefund.error;
          } else {
            const { error: auditError } = await supabase.from("refund_requests").update({
              razorpay_refund_id: razorpayRefund.refundId,
              refund_amount: Number(order.total),
            }).eq("id", refundId);
            if (auditError) refundError = auditError.message;
          }
        }

        if (!refundError && order) {
          await reverseOrderEarning(
            supabase,
            {
              id: order.id,
              order_number: order.order_number,
              seller_id: order.seller_id,
              status: order.status,
              payment_status: order.payment_status,
              total: Number(order.total),
            },
            commissionRate
          );
          await restoreOrderStock(supabase, orderId);
          await restorePromoUsageOnRefund(supabase, {
            id: orderId,
            seller_promo_id: (order as { seller_promo_id?: string | null }).seller_promo_id ?? null,
            platform_promo_id: (order as { platform_promo_id?: string | null }).platform_promo_id ?? null,
          });
          await supabase
            .from("orders")
            .update({ payment_status: "Refunded", status: "Cancelled" })
            .eq("id", orderId);
        }
      } else if (bookingId) {
        // Practitioner-session refunds are approved for manual bank transfer only.
        // This branch intentionally does not call the payment gateway or alter checkout.
        const { data: booking } = await supabase
          .from("practitioner_bookings")
          .select("id, booking_status, payment_status, amount, total_paid_amount_inr")
          .eq("id", bookingId)
          .maybeSingle();

        if (!booking) {
          refundError = "Booking not found";
        } else {
          const refundAmountInr = Number((existing as { refund_amount?: number | null }).refund_amount ?? 0);
          if (!Number.isFinite(refundAmountInr) || refundAmountInr < 0) {
            refundError = "Invalid approved refund amount";
          } else if (refundAmountInr > Number((booking as { total_paid_amount_inr?: number | null }).total_paid_amount_inr ?? booking.amount)) {
            refundError = "Refund amount exceeds the customer's payment";
          }
          // No gateway refund and no practitioner wallet adjustment here.
          // Wallet reconciliation happens only after the admin records the manual transfer.
        }
      }

      if (refundError) {
        return res.status(502).json({ error: refundError });
      }
    }

    let finalUpdate = supabase
      .from("refund_requests")
      .update({
        status,
        admin_notes: adminNotes,
        reviewed_by: admin.id,
        reviewed_at: new Date().toISOString(),
        processed_at: status === "approved" && isStoreOrderRefund ? new Date().toISOString() : null,
      })
      .eq("id", refundId)
      .not("status", "in", '("approved","rejected","paid")');

    // Prevent review/rejection from racing an approval that has already claimed
    // the request, and require the approval claim before finalizing approval.
    if (status === "approved" && isStoreOrderRefund) {
      finalUpdate = finalUpdate.not("processing_started_at", "is", null);
    } else {
      finalUpdate = finalUpdate.is("processing_started_at", null);
    }

    const { data: refund, error } = await finalUpdate.select().maybeSingle();
    if (error) return res.status(400).json({ error: error.message });
    if (!refund) {
      return res.status(409).json({ error: "Refund status changed concurrently; refresh and reconcile before retrying." });
    }

    if (status === "approved") {
      await dispatchUserNotification(supabase, {
        userId,
        event: "refund_approved",
        message: bookingId
          ? Number((refund as { refund_amount?: number | null }).refund_amount ?? 0) > 0
            ? `Your booking refund of ₹${Number((refund as { refund_amount?: number | null }).refund_amount).toLocaleString("en-IN")} has been approved. Nature's Grace will arrange the bank transfer manually and notify you once it is sent.`
            : "Your cancellation has been approved. No refund is due under the applicable cancellation policy."
          : `Your refund request ${refundId} has been approved.`,
        linkRoute: "OrderHistory",
        emailTemplateOverride: bookingId ? "booking_refund_approved_manual" : undefined,
        emailVars: {
          reference: refundId,
          amount: `₹${Number((refund as { refund_amount?: number | null }).refund_amount ?? 0).toLocaleString("en-IN")}`,
        },
      });
    } else if (status === "rejected") {
      await dispatchUserNotification(supabase, {
        userId,
        event: "refund_approved",
        message: "Your refund request was reviewed and could not be approved.",
        linkRoute: "OrderHistory",
        emailVars: { reference: refundId },
      });
    }

    await insertActivityLog(supabase, {
      actorId: admin.id,
      actorName: admin.email,
      actionType: "store",
      description: `Refund request ${refundId} marked ${status}`,
      targetType: "refund",
      targetId: refundId,
    });

    return res.json({ ok: true, refund });
  });

  app.post("/api/admin/refunds/:id/mark-paid", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const refundId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const body = req.body as { bankTransferReference?: unknown; adminNotes?: unknown };
    const bankTransferReference = typeof body.bankTransferReference === "string"
      ? body.bankTransferReference.trim().slice(0, 200)
      : "";
    const adminNotes = typeof body.adminNotes === "string" ? body.adminNotes.trim().slice(0, 2000) : undefined;
    if (!bankTransferReference) {
      return res.status(400).json({ error: "Bank transfer reference is required" });
    }

    const supabase = requireSupabaseAdmin();
    const { data: refund, error: refundError } = await supabase
      .from("refund_requests")
      .select("id, user_id, booking_id, order_id, status, refund_amount")
      .eq("id", refundId)
      .maybeSingle();

    if (refundError || !refund) return res.status(404).json({ error: "Refund request not found" });
    if (!refund.booking_id || refund.order_id) {
      return res.status(400).json({ error: "This action is only for practitioner booking refunds" });
    }
    if (refund.status !== "approved") {
      return res.status(409).json({ error: "Only approved refund requests can be marked paid" });
    }

    const amount = Number(refund.refund_amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "There is no refundable amount to transfer" });
    }

    const { data: booking, error: bookingError } = await supabase
      .from("practitioner_bookings")
      .select("id, booking_number, practitioner_id, booking_status, payment_status, amount, total_paid_amount_inr, service_name")
      .eq("id", refund.booking_id)
      .maybeSingle();
    if (bookingError || !booking) return res.status(404).json({ error: "Related booking not found" });

    // The transfer has already been made by the admin. Record its reference and
    // reconcile the practitioner's earning ledger idempotently; no gateway call.
    const commissionRate = await fetchCommissionRate(supabase);
    const reversal = await reverseBookingEarningForRefund(supabase, {
      id: booking.id,
      booking_number: booking.booking_number,
      practitioner_id: booking.practitioner_id,
      booking_status: booking.booking_status,
      payment_status: booking.payment_status,
      amount: Number(booking.amount),
      service_name: booking.service_name,
    }, refundId, amount,
    Number((booking as { total_paid_amount_inr?: number | null }).total_paid_amount_inr ?? booking.amount),
    commissionRate);
    if (reversal.error) {
      return res.status(502).json({ error: `Transfer reference received, but wallet reconciliation failed: ${reversal.error}. Retry this action with the same reference.` });
    }

    const { data: updated, error: updateError } = await supabase
      .from("refund_requests")
      .update({
        status: "paid",
        bank_transfer_reference: bankTransferReference,
        paid_at: new Date().toISOString(),
        paid_by: admin.id,
        processed_at: new Date().toISOString(),
        ...(adminNotes ? { admin_notes: adminNotes } : {}),
      })
      .eq("id", refundId)
      .eq("status", "approved")
      .select("id, user_id, refund_amount, bank_transfer_reference, paid_at, status")
      .maybeSingle();

    if (updateError || !updated) {
      return res.status(409).json({ error: updateError?.message ?? "Refund status changed concurrently. Refresh before retrying." });
    }

    await dispatchUserNotification(supabase, {
      userId: refund.user_id,
      event: "refund_approved",
      message: `Your manual bank transfer of ₹${amount.toLocaleString("en-IN")} has been recorded as sent. Reference: ${bankTransferReference}.`,
      linkRoute: "OrderHistory",
      emailTemplateOverride: "refund_paid",
      emailVars: { amount: `₹${amount.toLocaleString("en-IN")}`, reference: bankTransferReference },
    });

    await insertActivityLog(supabase, {
      actorId: admin.id,
      actorName: admin.email,
      actionType: "store",
      description: `Manual booking refund ${refundId} marked paid; bank transfer reference ${bankTransferReference}`,
      targetType: "refund",
      targetId: refundId,
    });

    return res.json({ ok: true, refund: updated, reversedPractitionerEarning: reversal.reversedAmount });
  });

  app.post("/api/admin/users/:id/role", async (req: Request, res: Response) => {
    const admin = await requireRole(req, res, "Admin");
    if (!admin) return;

    const userId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const { role } = req.body as { role?: string };
    if (!role || !["User", "Seller", "Practitioner", "Admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const supabase = requireSupabaseAdmin();
    const { data, error } = await supabase.rpc("admin_provision_user_role", {
      p_user_id: userId,
      p_role: role,
      p_admin_id: admin.id,
    });

    if (error) return res.status(400).json({ error: error.message });
    const result = data as { ok?: boolean; error?: string };
    if (!result?.ok) {
      return res.status(400).json({ error: result?.error ?? "Could not update role" });
    }

    await insertActivityLog(supabase, {
      actorId: admin.id,
      actorName: admin.email,
      actionType: "user",
      description: `User ${userId} role set to ${role}`,
      targetType: "user",
      targetId: userId,
    });

    return res.json({ ok: true, role });
  });
}
