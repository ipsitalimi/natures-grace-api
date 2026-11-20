import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatBankAccountLabel,
  isBankAccountLinkedForPayout,
  validateBankDetailsInput,
} from "../server/lib/walletBank";

test("practitioner bank details accept a valid holder, bank and four digits", () => {
  assert.deepEqual(
    validateBankDetailsInput({
      bankName: " HDFC Bank ",
      last4: "xx 1234",
      accountHolder: " A Practitioner ",
    }),
    { ok: true, label: "HDFC Bank ···· 1234", accountHolder: "A Practitioner" },
  );
});

test("practitioner bank details reject missing, malformed and oversized values", () => {
  assert.equal(validateBankDetailsInput({ bankName: "HDFC", last4: "123", accountHolder: "A User" }).ok, false);
  assert.equal(validateBankDetailsInput({ bankName: "H", last4: "1234", accountHolder: "A User" }).ok, false);
  assert.equal(validateBankDetailsInput({ bankName: "HDFC", last4: "1234", accountHolder: " " }).ok, false);
  assert.equal(validateBankDetailsInput({ bankName: "H".repeat(81), last4: "1234", accountHolder: "A User" }).ok, false);
  assert.equal(validateBankDetailsInput({ bankName: "HDFC", last4: "1234", accountHolder: "A".repeat(101) }).ok, false);
  assert.equal(
    validateBankDetailsInput({ bankName: 123 as unknown as string, last4: "1234", accountHolder: "A User" }).ok,
    false,
  );
});

test("account holder is trimmed before it is persisted", () => {
  const result = validateBankDetailsInput({
    bankName: " HDFC Bank ",
    last4: "1234",
    accountHolder: "  A Practitioner  ",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.accountHolder, "A Practitioner");
});

test("bank account labels use only the validated display fields", () => {
  assert.equal(formatBankAccountLabel("HDFC Bank", "1234"), "HDFC Bank ···· 1234");
  assert.equal(isBankAccountLinkedForPayout("HDFC Bank ···· 4821"), true);
  assert.equal(isBankAccountLinkedForPayout("Bank account not linked"), false);
  assert.equal(isBankAccountLinkedForPayout(null), false);
});
