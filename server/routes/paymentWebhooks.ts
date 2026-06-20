import type { Express, Request, Response } from "express";
import {
  handlePaymentCaptured,
  verifyPaymentWebhookSignature,
} from "../services/paymentWebhooks";

/** POST /api/webhooks/razorpay — Razorpay payment events (payment.captured) */
async function handleRazorpayPaymentWebhook(req: Request, res: Response) {
  try {
    const signature = req.header("x-razorpay-signature");
    const rawBody =
      (req as Request & { rawBody?: Buffer }).rawBody ??
      Buffer.from(JSON.stringify(req.body));

    if (!verifyPaymentWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const payload = req.body as {
      event?: string;
      payload?: {
        payment?: { entity?: Record<string, unknown> };
      };
    };

    const event = payload.event ?? "";
    if (event === "payment.captured" || event === "order.paid") {
      const result = await handlePaymentCaptured(payload.payload ?? {});
      return res.status(200).json({ received: true, ...result });
    }

    return res.status(200).json({ received: true, matched: false, event });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook failed";
    console.error("[paymentWebhooks]", err);
    return res.status(500).json({ error: message });
  }
}

export function registerPaymentWebhookRoutes(app: Express) {
  app.post("/api/webhooks/razorpay", handleRazorpayPaymentWebhook);
}
