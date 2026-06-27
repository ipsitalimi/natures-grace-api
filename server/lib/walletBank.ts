export function isBankAccountLinkedForPayout(label: string | null | undefined): boolean {
  const trimmed = label?.trim() ?? "";
  if (!trimmed) return false;
  return !trimmed.toLowerCase().includes("not linked");
}

export function formatBankAccountLabel(bankName: string, last4: string): string {
  return `${bankName.trim()} ···· ${last4.trim()}`;
}

export function validateBankDetailsInput(input: {
  bankName?: string;
  last4?: string;
  accountHolder?: string;
}): { ok: true; label: string } | { ok: false; error: string } {
  const bankName = input.bankName?.trim() ?? "";
  const last4 = (input.last4 ?? "").replace(/\D/g, "").slice(-4);
  const accountHolder = input.accountHolder?.trim() ?? "";

  if (!accountHolder || accountHolder.length < 2) {
    return { ok: false, error: "Account holder name is required" };
  }
  if (!bankName || bankName.length < 2) {
    return { ok: false, error: "Bank name is required" };
  }
  if (last4.length !== 4) {
    return { ok: false, error: "Enter the last 4 digits of your account number" };
  }

  return { ok: true, label: formatBankAccountLabel(bankName, last4) };
}
