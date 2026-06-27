import type { Express, Request, Response } from "express";
import {
  confirmStoreOrderPayment,
  createStoreRazorpayOrder,
} from "../services/storeOrderPayment";
import { createValidatedStoreOrder } from "../services/storeOrderCreation";
import { requireBearerUser } from "../middleware/auth";

/** POST /api/store/checkout/create-order */
async function handleCreateOrder(req: Request, res: Response) {
  try {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const body = req.body as {
      customerName?: string;
      customerEmail?: string;
      items?: { productId: string; quantity: number }[];
      deliveryOption?: string;
      notes?: string;
      sellerPromoId?: string | null;
      platformPromoId?: string | null;
    };

    if (!body.items?.length) {
      return res.status(400).json({ error: "items are required" });
    }

    const result = await createValidatedStoreOrder({
      userId: user.id,
      customerName: body.customerName?.trim() || user.email?.split("@")[0] || "Guest",
      customerEmail: body.customerEmail ?? user.email ?? undefined,
      items: body.items,
      deliveryOption: body.deliveryOption,
      notes: body.notes,
      sellerPromoId: body.sellerPromoId ?? null,
      platformPromoId: body.platformPromoId ?? null,
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      subtotal: result.subtotal,
      deliveryFee: result.deliveryFee,
      promoDiscount: result.promoDiscount,
      total: result.total,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Create order failed";
    return res.status(500).json({ error: message });
  }
}

/** POST /api/store/checkout/create-payment */
async function handleCreatePayment(req: Request, res: Response) {
  try {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const { storeOrderId } = req.body as { storeOrderId?: string };

    if (!storeOrderId) {
      return res.status(400).json({ error: "storeOrderId is required" });
    }

    const result = await createStoreRazorpayOrder({
      storeOrderId,
      userId: user.id,
    });

    if (!result.ok) {
      const status = result.error.includes("not belong") ? 403 : 502;
      return res.status(status).json({ error: result.error });
    }

    return res.json({
      razorpayOrderId: result.razorpayOrderId,
      amountPaise: result.amountPaise,
      amountInr: result.amountInr,
      currency: result.currency,
      keyId: result.keyId,
      devMode: result.devMode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Create payment failed";
    return res.status(500).json({ error: message });
  }
}

/** POST /api/store/checkout/confirm-payment */
async function handleConfirmPayment(req: Request, res: Response) {
  try {
    const user = await requireBearerUser(req, res);
    if (!user) return;

    const { storeOrderId, razorpayOrderId, paymentId, signature, devMode } =
      req.body as {
        storeOrderId?: string;
        razorpayOrderId?: string;
        paymentId?: string;
        signature?: string;
        devMode?: boolean;
      };

    if (!storeOrderId || !razorpayOrderId) {
      return res.status(400).json({ error: "storeOrderId and razorpayOrderId are required" });
    }

    const result = await confirmStoreOrderPayment({
      storeOrderId,
      userId: user.id,
      razorpayOrderId,
      paymentId: paymentId ?? "",
      signature,
      devMode,
    });

    if (!result.ok) {
      const status = result.error.includes("not belong") ? 403 : 400;
      return res.status(status).json({ error: result.error });
    }

    return res.json({
      paymentId: result.paymentId,
      orderNumber: result.orderNumber,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Confirm payment failed";
    return res.status(500).json({ error: message });
  }
}

export function registerStoreCheckoutRoutes(app: Express) {
  app.post("/api/store/checkout/create-order", handleCreateOrder);
  app.post("/api/store/checkout/create-payment", handleCreatePayment);
  app.post("/api/store/checkout/confirm-payment", handleConfirmPayment);
}
