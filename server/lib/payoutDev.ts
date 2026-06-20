/** Dev-only payout auto-complete; never enabled in production. */
export function devAutoCompleteEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return (
    process.env.PAYOUT_DEV_AUTO_COMPLETE === "true" ||
    process.env.PAYOUT_DEV_AUTO_COMPLETE === "1"
  );
}
