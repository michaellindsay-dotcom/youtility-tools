import type { Company } from "../types";

// Plan feature keys (must match the toggles in admin.html's plan editor).
// `planner` = the Success Planner (shift time keeper, goal tracking, pace
// projections) — an optional service bundled into the top tiers.
export const FEATURES = ["map", "skiptrace", "scheduling", "calendar", "rewards", "analytics", "chat", "planner", "pitch"] as const;
export type FeatureKey = (typeof FEATURES)[number];

// Whether a company's plan includes a feature. A company with no `features`
// array set (legacy / unpriced) gets EVERYTHING — so gating only kicks in once
// a plan is assigned. A suspended company loses everything but the basics.
export function hasFeature(company: Company | null | undefined, key: FeatureKey): boolean {
  if (!company) return true;
  if (company.billingExempt) return true; // comped → everything on
  if (company.status === "suspended" && key !== "map") return false;
  if (!Array.isArray(company.features)) return true;
  return company.features.includes(key);
}
