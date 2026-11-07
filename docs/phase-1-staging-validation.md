# Nature's Grace Phase 1 — Staging Validation Checklist

**Scope:** payment, booking/order fulfillment, wallet ledger/balances, refunds, and payouts.  
**Environment:** staging only. Do not run against production.  
**Prerequisites:** deploy the API branch and apply the reviewed migrations to a staging database; use Razorpay test mode and test accounts/products/practitioners. Record run IDs, entity IDs, gateway IDs, and screenshots/log references.

## Safety and setup
- [ ] Confirm staging API, Supabase project, and Razorpay credentials are test-mode only.
- [ ] Snapshot/backup staging database before applying migrations.
- [ ] Confirm migration order: 001 through 008 (plus any later corrective migrations).
- [ ] Confirm all required columns, constraints, indexes, and RPCs exist.
- [ ] Confirm RPC execute grants are limited to service_role where intended.
- [ ] Seed test user, practitioner, seller, wallet balances, product stock, promo codes, and booking slots.
- [ ] Record initial wallet balances, ledger totals, stock counts, promo usage counts, payout status, and payment state.

## Booking payment and fulfillment
- [ ] Successful checkout creates exactly one paid booking, one earning ledger row, and one held-balance credit.
- [ ] Repeat payment confirmation for the same payment/order does not duplicate booking or earning.
- [ ] Deliver the same webhook twice; state and balances remain unchanged after first fulfillment.
- [ ] Run confirmation and webhook concurrently; only one booking/earning is created.
- [ ] Invalid user/order binding is rejected.
- [ ] Missing/invalid booking draft or nonpositive amount fails without partial booking/wallet changes.
- [ ] A retry after transient failure completes fulfillment without duplicate booking/ledger rows.

## Store order fulfillment
- [ ] Successful paid order credits seller earning once and decrements stock exactly once.
- [ ] Duplicate webhook/fulfillment does not double-credit seller or decrement stock twice.
- [ ] Insufficient stock fails transactionally; no partial stock decrement remains.
- [ ] Paid order retry resumes fulfillment after a simulated downstream failure.
- [ ] Order payment verification rejects mismatched Razorpay order ID, payment ID, amount, or currency.
- [ ] Promo usage increments once per order, including repeated webhooks.
- [ ] Refund restores stock and promo usage once; repeated refund processing does not restore twice.

## Refunds
- [ ] Full store refund reverses seller earning once, restores stock/promo usage once, and marks order refunded/cancelled.
- [ ] Full booking refund reverses practitioner earning once and updates booking state.
- [ ] Partial booking refund adjusts earning by the expected proportional amount.
- [ ] Repeat refund callback/request cannot duplicate reversal or gateway refund.
- [ ] Simulate Razorpay success followed by database failure: refund remains clearly marked for reconciliation; retry is blocked from issuing a second gateway refund.
- [ ] Admin can reconcile gateway refund ID/status and safely finalize the local record.
- [ ] Zero-refund cancellation under policy does not issue a gateway refund or reverse earnings incorrectly.
- [ ] Refund request rejection does not change payment, booking/order, wallet, stock, or promo state.

## Wallet earning release and reversal
- [ ] Release seller earning: held decreases, available increases, total earned unchanged, ledger event created once.
- [ ] Release practitioner earning: same expected accounting behavior.
- [ ] Repeat release is idempotent.
- [ ] Reverse unreleased earning: held and total earned decrease once.
- [ ] Reverse released earning: available and total earned decrease once.
- [ ] Repeat reversal is idempotent.
- [ ] Attempt release/reversal with wrong wallet/entity ID fails or safely no-ops; no cross-wallet mutation.
- [ ] Compare wallet balance fields against ledger-derived totals and investigate any discrepancy.

## Payout lifecycle
- [ ] Seller/practitioner payout request reserves available funds, increases pending payout, creates payout record and debit ledger row atomically.
- [ ] Concurrent payout requests cannot overdraw the wallet.
- [ ] Invalid amount, missing wallet, or insufficient funds leaves wallet and ledger unchanged.
- [ ] Admin moves payout Pending → Under Review → Processing → Completed; only status/audit data changes on each transition.
- [ ] Reject payout: available funds are restored, pending payout decreases, reversal ledger row is created exactly once.
- [ ] Repeated rejection/status update cannot restore funds twice.
- [ ] Completed/Rejected/Failed/Cancelled terminal payout cannot be transitioned again.
- [ ] Notification failure after successful status change does not roll back payout state; retry does not duplicate wallet changes.

## Reconciliation assertions
- [ ] Every paid booking/order has the expected fulfillment records and payment IDs.
- [ ] Each earning has exactly one release or reversal event as applicable.
- [ ] Payout ledger debit/reversal totals agree with payout status and wallet balances.
- [ ] Seller/practitioner wallet balances reconcile to ledger, accounting for held funds and pending payouts.
- [ ] Stock counts and promo usage match paid/refunded test orders.
- [ ] No test webhook or refund is accidentally sent to live Razorpay.

## Sign-off
- [ ] All critical cases pass.
- [ ] Failed cases include reproducible steps and related IDs.
- [ ] Staging reconciliation completed and discrepancies resolved.
- [ ] Explicit approval obtained before production migration/deployment or merge to main.
