import type { Express, Request, Response } from "express";
import { requireSupabaseAdmin } from "../lib/supabaseAdmin";
import { requireRole } from "../middleware/auth";
import { dispatchUserNotification } from "../services/notificationDispatch";
import { sendEmailToUserId } from "../services/email/emailService";
import { insertActivityLog } from "../services/activityLogAdmin";
import { createRazorpayRefund } from "../services/razorpayRefund";
import { reverseOrderEarning } from "../services/sellerWalletLedger";
import { reverseBookingEarning } from "../services/practitionerWalletLedger";
import { fetchCommissionRate } from "../services/platformSettings";
import {
  restoreOrderStock,
  restorePromoUsageOnRefund,
} from "../services/orderFulfillment";
import { isRazorpayConfigured } from "../services/razorpayX";

type PayoutStatus = "Pending" | "Under Review" | "Processing" | "Completed" | "Rejected";

async function updateSellerPayoutStatus(
  payoutId: string,
  status: PayoutStatus,
  adminId: string,
  rejectionReason?: string
) {
  const supabase = requireSupabaseAdmin();

  const { data: payout } = await supabase
    .from("seller_payouts")
    .select("*, seller_wallets(seller_id, sellers(profile_id))")
    .eq("id", payoutId)
    .maybeSingle();

  if (!payout) return { error: "Payout not found" };

  if (status === "Completed") {
    const notes = String((payout as { notes?: string }).notes ?? "");
    const isManual = notes.includes("Manual withdrawal");
    const razorpayId = (payout as { razorpay_payout_id?: string | null }).razorpay_payout_id;
    if (isRazorpayConfigured() && !isManual && !razorpayId) {
      return { error: "Razorpay payout confirmation required before marking completed" };
    }
  }

  const patch: Record<string, unknown> = {
    status,
    processed_by: adminId,
    updated_at: new Date().toISOString(),
  };
  if (status === "Completed") patch.completed_at = new Date().toISOString();
  if (status === "Rejected") {
    patch.rejection_reason = rejectionReason ?? "Rejected by admin";
    const amount = Number((payout as { amount: number }).amount);
    const walletId = (payout as { wallet_id: string }).wallet_id;
    const { data: wallet } = await supabase
      .from("seller_wallets")
      .select("available_balance, pending_payout")
      .eq("id", walletId)
      .single();
    if (wallet) {
      await supabase
        .from("seller_wallets")
        .update({
          available_balance: Number(wallet.available_balance) + amount,
          pending_payout: Math.max(0, Number(wallet.pending_payout) - amount),
        })
        .eq("id", walletId);
    }
  }

  await supabase.from("seller_payouts").update(patch).eq("id", payoutId);

  const profileId =
    (payout as { seller_wallets?: { sellers?: { profile_id?: string } } }).seller_wallets?.sellers
      ?.profile_id ?? null;

  if (profileId) {
    const amountStr = `₹${Number((payout as { amount: number }).amount).toLocaleString("en-IN")}`;
    if (status === "Completed") {
      await dispatchUserNotification(supabase, {
        userId: profileId,
        event: "withdrawal_completed",
        message: `Your withdrawal of ${amountStr} has been completed.`,
        linkRoute: "Main",
      });
    } else if (status === "Rejected") {
      await dispatchUserNotification(supabase, {
        userId: profileId,
        event: "withdrawal_received",
        message: `Your withdrawal request was not approved. Funds returned to your wallet.`,
        linkRoute: "Main",
      });
    }
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

  const { data: payout } = await supabase
    .from("practitioner_payouts")
    .select("*, practitioner_wallets(practitioner_id, practitioners(profile_id))")
    .eq("id", payoutId)
    .maybeSingle();

  if (!payout) return { error: "Payout not found" };

  if (status === "Completed") {
    const notes = String((payout as { notes?: string }).notes ?? "");
    const isManual = notes.includes("Manual withdrawal");
    const razorpayId = (payout as { razorpay_payout_id?: string | null }).razorpay_payout_id;
    if (isRazorpayConfigured() && !isManual && !razorpayId) {
      return { error: "Razorpay payout confirmation required before marking completed" };
    }
  }

  const patch: Record<string, unknown> = {
    status,
    processed_by: adminId,
    updated_at: new Date().toISOString(),
  };
  if (status === "Completed") patch.completed_at = new Date().toISOString();
  if (status === "Rejected") {
    patch.rejection_reason = rejectionReason ?? "Rejected by admin";
    const amount = Number((payout as { amount: number }).amount);
    const walletId = (payout as { wallet_id: string }).wallet_id;
    const { data: wallet } = await supabase
      .from("practitioner_wallets")
      .select("available_balance, pending_payout")
      .eq("id", walletId)
      .single();
    if (wallet) {
      await supabase
        .from("practitioner_wallets")
        .update({
          available_balance: Number(wallet.available_balance) + amount,
          pending_payout: Math.max(0, Number(wallet.pending_payout) - amount),
        })
        .eq("id", walletId);
    }
  }

  await supabase.from("practitioner_payouts").update(patch).eq("id", payoutId);

  const profileId =
    (payout as { practitioner_wallets?: { practitioners?: { profile_id?: string } } })
      .practitioner_wallets?.practitioners?.profile_id ?? null;

  if (profileId && status === "Completed") {
    const amountStr = `₹${Number((payout as { amount: number }).amount).toLocaleString("en-IN")}`;
    await dispatchUserNotification(supabase, {
      userId: profileId,
      event: "withdrawal_completed",
      message: `Your withdrawal of ${amountStr} has been completed.`,
      linkRoute: "Main",
    });
  }

  return { ok: true };
}

export function registerAdminOperationsRoutes(app: Express) {
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

    const { status, adminNotes } = req.body as {
      status: "in_review" | "approved" | "rejected";
      adminNotes?: string;
    };
    const refundId = String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
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
    if (existingStatus === "approved" || existingStatus === "rejected") {
      return res.status(409).json({ error: `Refund already ${existingStatus}` });
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
            seller_promo_id: (order as { seller_promo_id?: string | null }).seller_promo_id ?? null,
            platform_promo_id: (order as { platform_promo_id?: string | null }).platform_promo_id ?? null,
          });
          await supabase
            .from("orders")
            .update({ payment_status: "Refunded", status: "Cancelled" })
            .eq("id", orderId);
        }
      } else if (bookingId) {
        const { data: booking } = await supabase
          .from("practitioner_bookings")
          .select(
            "id, booking_number, practitioner_id, booking_status, payment_status, amount, service_name, razorpay_payment_id"
          )
          .eq("id", bookingId)
          .maybeSingle();

        if (!booking) {
          refundError = "Booking not found";
        } else if (!booking.razorpay_payment_id) {
          refundError = "Booking has no Razorpay payment ID — process refund manually";
        } else {
          const razorpayRefund = await createRazorpayRefund({
            paymentId: booking.razorpay_payment_id as string,
            amountInr: Number(booking.amount),
            notes: { refund_request_id: refundId },
          });
          if (!razorpayRefund.ok) {
            refundError = razorpayRefund.error;
          }
        }

        if (!refundError && booking) {
          await reverseBookingEarning(
            supabase,
            {
              id: booking.id,
              booking_number: booking.booking_number,
              practitioner_id: booking.practitioner_id,
              booking_status: booking.booking_status,
              payment_status: booking.payment_status,
              amount: Number(booking.amount),
              service_name: booking.service_name,
            },
            commissionRate
          );
          await supabase
            .from("practitioner_bookings")
            .update({ payment_status: "Refunded", booking_status: "Cancelled" })
            .eq("id", bookingId);
        }
      }

      if (refundError) {
        return res.status(502).json({ error: refundError });
      }
    }

    const { data: refund, error } = await supabase
      .from("refund_requests")
      .update({
        status,
        admin_notes: adminNotes ?? null,
        reviewed_by: admin.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", refundId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    if (status === "approved") {
      await dispatchUserNotification(supabase, {
        userId,
        event: "refund_approved",
        message: "Your refund request has been approved. Funds will return within 7–10 business days.",
        linkRoute: "OrderHistory",
        emailVars: { reference: refundId },
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
