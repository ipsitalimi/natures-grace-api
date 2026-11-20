export function isBankAccountLinkedForPayout(label: string | null | undefined): boolean {
  const trimmed = label?.trim() ?? "";
  if (!trimmed) return false;
  return !trimmed.toLowerCase().includes("not linked");
}

export function isPractitionerBankAccountLinkedForPayout(label: string | null | undefined): boolean {
  const normalized = label?.trim().toLowerCase() ?? "";
  if (normalized === "hdfc bank ···· 4821") return false;
  return isBankAccountLinkedForPayout(label);
}

export function formatBankAccountLabel(bankName: string, last4: string): string {
  return `${bankName.trim()} ···· ${last4.trim()}`;
}

export function validateBankDetailsInput(input: {
  bankName?: string;
  last4?: string;
  accountHolder?: string;
}): { ok: true; label: string; accountHolder: string } | { ok: false; error: string } {
  const rawBankName = typeof input.bankName === "string" ? input.bankName : "";
  const rawLast4 = typeof input.last4 === "string" ? input.last4 : "";
  const rawAccountHolder = typeof input.accountHolder === "string" ? input.accountHolder : "";
  const bankName = rawBankName.trim();
  const accountHolder = rawAccountHolder.trim();
  const last4 = rawLast4.replace(/\D/g, "").slice(-4);

  if (accountHolder.length < 2 || accountHolder.length > 100) {
    return { ok: false, error: "Enter an account holder name between 2 and 100 characters" };
  }
  if (bankName.length < 2 || bankName.length > 80) {
    return { ok: false, error: "Enter a bank name between 2 and 80 characters" };
  }
  if (!/^\d{4}$/.test(last4)) {
    return { ok: false, error: "Enter exactly the last 4 digits of your account number" };
  }

  return { ok: true, label: formatBankAccountLabel(bankName, last4), accountHolder };
}
