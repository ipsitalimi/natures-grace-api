import type { Express } from "express";
import { createServer, type Server } from "node:http";
import { registerPayoutRoutes } from "./routes/payouts";
import { registerPractitionerPayoutRoutes } from "./routes/practitionerPayouts";
import { registerBookingCheckoutRoutes } from "./routes/bookingCheckout";
import { registerEventCheckoutRoutes } from "./routes/eventCheckout";
import { registerBookingCancellationRoutes } from "./routes/bookingCancellation";
import { registerBookingRescheduleRoutes } from "./routes/bookingReschedule";
import { registerAdminBookingScheduleRoutes } from "./routes/adminBookingSchedule";
import { registerStoreCheckoutRoutes } from "./routes/storeCheckout";
import { registerWalletLedgerRoutes } from "./routes/walletLedger";
import { registerAdminOperationsRoutes } from "./routes/adminOperations";
import { registerTransactionalHooksRoutes } from "./routes/transactionalHooks";
import { registerPaymentWebhookRoutes } from "./routes/paymentWebhooks";
import { registerAccountRoutes } from "./routes/account";

export async function registerRoutes(app: Express): Promise<Server> {
  registerPayoutRoutes(app);
  registerPractitionerPayoutRoutes(app);
  registerBookingCheckoutRoutes(app);
  registerEventCheckoutRoutes(app);
  registerBookingCancellationRoutes(app);
  registerBookingRescheduleRoutes(app);
  registerAdminBookingScheduleRoutes(app);
  registerStoreCheckoutRoutes(app);
  registerWalletLedgerRoutes(app);
  registerAdminOperationsRoutes(app);
  registerTransactionalHooksRoutes(app);
  registerPaymentWebhookRoutes(app);
  registerAccountRoutes(app);

  const httpServer = createServer(app);

  return httpServer;
}
