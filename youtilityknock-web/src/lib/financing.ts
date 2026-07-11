// Sungage solar-loan options + payment math for the proposal's pricing slide.
// Payments are presentation estimates — final terms are confirmed by Sungage on
// credit approval. The "dealer fee" is the lender's buy-down cost: to net the
// system price the dealer must finance a grossed-up amount, so a lower rate
// carries a higher dealer fee (and vice-versa).

// Sungage dealer login portal — used as the fallback "apply" destination when a
// company hasn't wired up its own Sungage API/application link yet.
export const SUNGAGE_PORTAL_URL =
  "https://auth.sungage.com/u/login?state=hKFo2SBCOFRFQkdoNnN6bFczVjVrM05fQXlVMTFhelZlQWNCbKFur3VuaXZlcnNhbC1sb2dpbqN0aWTZIGlneGFEX1RjRmhnVHhOZTR5TmMyZ2ZwQVF1dTVYNzNHo2NpZNkgZjRnY2FqdzVIMmRCaXozaWw4RUN2c3g1bkRYTTJNY1Q";

export type FinanceOptionId = string;

export interface FinanceOption {
  id: string;
  name: string;
  blurb: string;
  termYears: number;
  apr: number; // annual rate, decimal (0.0399 = 3.99%)
  dealerFee: number; // decimal (0.3299 = 32.99%)
  kind: "escalator" | "deferred" | "level";
  escalator?: number; // annual payment step-up, decimal
  deferMonths?: number; // deferral window
  deferPct?: number; // portion of the balance deferred
  // Company-configurable extras (set in the Battery Tool → Financing editor).
  financeCompany?: string; // lender name shown on the "Apply" button
  applyUrl?: string; // where the homeowner applies (falls back to Sungage portal)
  enabled?: boolean; // show this plan on the proposal (default true)
}

export const FINANCE_OPTIONS: FinanceOption[] = [
  {
    id: "sunrise",
    name: "Sungage Sunrise",
    blurb: "Lowest 3.99% rate — payment steps up 2.9% a year",
    termYears: 20,
    apr: 0.0399,
    dealerFee: 0.3299,
    kind: "escalator",
    escalator: 0.029,
  },
  {
    id: "deferred",
    name: "Sungage Deferred",
    blurb: "3.99% with lower payments for the first 3 years",
    termYears: 20,
    apr: 0.0399,
    dealerFee: 0.3149,
    kind: "deferred",
    deferMonths: 36,
    deferPct: 0.25,
  },
  {
    id: "standard",
    name: "Sungage 8.99%",
    blurb: "Smallest financed amount — level payments, no step-up",
    termYears: 20,
    apr: 0.0899,
    dealerFee: 0.0399,
    kind: "level",
  },
];

export const financeOptionById = (id: string): FinanceOption =>
  FINANCE_OPTIONS.find((o) => o.id === id) || FINANCE_OPTIONS[0];

// The finance plans a proposal should offer: a company's own configured plans
// (only the enabled ones), or the built-in Sungage defaults when none are set.
export function resolveFinanceOptions(
  company?: { financeOptions?: FinanceOption[] } | null,
): FinanceOption[] {
  const custom = company?.financeOptions;
  if (Array.isArray(custom) && custom.length) {
    const on = custom.filter((o) => o && o.enabled !== false);
    if (on.length) return on;
  }
  return FINANCE_OPTIONS;
}

// Standard fully-amortizing monthly payment.
function amortize(principal: number, monthlyRate: number, n: number): number {
  if (principal <= 0 || n <= 0) return 0;
  if (monthlyRate <= 0) return principal / n;
  const f = Math.pow(1 + monthlyRate, n);
  return (principal * monthlyRate * f) / (f - 1);
}

export interface FinanceResult {
  financedAmount: number; // price grossed up by the dealer fee
  monthly: number; // first-year / initial monthly payment to display
  note?: string;
}

// systemPrice = the cash price the dealer needs to net. We gross it up by the
// dealer fee so the lender's payout to the dealer equals systemPrice.
export function computeFinance(opt: FinanceOption, systemPrice: number): FinanceResult {
  const price = Math.max(0, systemPrice || 0);
  const financedAmount = opt.dealerFee < 1 ? price / (1 - opt.dealerFee) : price;
  const r = opt.apr / 12;
  const n = opt.termYears * 12;

  if (opt.kind === "escalator" && opt.escalator) {
    // Solve for the starting monthly P0 so the present value of the escalating
    // payment stream equals the financed amount (payment steps up every 12 mo).
    let s = 0;
    for (let m = 1; m <= n; m++) {
      const yr = Math.floor((m - 1) / 12);
      s += Math.pow(1 + opt.escalator, yr) / Math.pow(1 + r, m);
    }
    const monthly = s > 0 ? financedAmount / s : amortize(financedAmount, r, n);
    return { financedAmount, monthly, note: `Payment increases ${(opt.escalator * 100).toFixed(1)}% each year.` };
  }

  if (opt.kind === "deferred" && opt.deferPct && opt.deferMonths) {
    // Initial payment is figured on the non-deferred portion; after the window
    // the deferred portion is added back and the loan re-amortizes higher.
    const initial = amortize(financedAmount * (1 - opt.deferPct), r, n);
    return {
      financedAmount,
      monthly: initial,
      note: `Lower payment for the first ${opt.deferMonths} months, then it re-amortizes.`,
    };
  }

  return { financedAmount, monthly: amortize(financedAmount, r, n) };
}

export const money0 = (n: number | undefined | null) =>
  typeof n === "number" && isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—";
