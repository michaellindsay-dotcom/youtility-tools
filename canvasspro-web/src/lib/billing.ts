import type { Company } from "../types";

// The message a user sees when their company is locked for non-payment (vs. a
// generic admin-deactivation). Surfaced on the login screen and the in-app gate.
export const PAYMENT_LOCK_MSG =
  "Please contact your administrator for payment to reactivate your account.";

// True when a company is locked specifically because of billing — an unpaid
// invoice (due on receipt), a dunning hold, or an expired trial — as opposed to
// a manual admin suspension. Drives which lockout message we show.
export function isBillingLocked(company: Company | null | undefined): boolean {
  if (!company) return false;
  const status = String(company.status || "active").toLowerCase();
  return Boolean(
    company.billingHold || company.trialExpired || company.pastDueSince || status === "past_due"
  );
}
