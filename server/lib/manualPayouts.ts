/** Practitioner and seller withdrawals are settled manually by admin (no RazorpayX). */

export const MANUAL_PAYOUT_MESSAGE =
  "Manual payouts are enabled. Please complete the transfer outside the application.";

/** Matches DB constraint on seller_payouts / practitioner_payouts status. */
export const MANUAL_PAYOUT_STATUS = "Under Review" as const;

export const MANUAL_PAYOUT_NOTES = "Pending manual transfer";
