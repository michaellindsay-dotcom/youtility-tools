import type { Company, UserProfile, Team } from "../types";

// Plan feature keys (must match the toggles in admin.html's plan editor).
// `planner` = the Success Planner (shift time keeper, goal tracking, pace
// projections) — an optional service bundled into the top tiers.
export const FEATURES = [
  "map", "skiptrace", "scheduling", "calendar", "rewards", "analytics", "chat", "planner", "pitch",
  // Newer services (also configurable per role/team). These default ON at the
  // company level so adding them never hides a tool from an existing company.
  "battery", "voice", "historical", "aiRecommend", "aiTerritories",
  // Core nav items that admins can declutter per position/team (default ON, so
  // they only ever disappear when a role/team is explicitly restricted).
  "movers", "leads", "team",
  // RallyCard — the digital business card + lead capture. Default ON company-
  // wide (same opt-out style as the row above) so it never disappears for an
  // existing customer; a company can still be RallyCard-only (see below).
  "card",
] as const;
export type FeatureKey = (typeof FEATURES)[number];

// Original keys: absence from a company's `features` array means OFF (legacy
// behavior). Keys NOT in this set default ON at the company level (opt-out), so
// the new per-role/team services only ever *restrict*, never silently disable.
const COMPANY_GATED = new Set<string>([
  "map", "skiptrace", "scheduling", "calendar", "rewards", "analytics", "chat", "planner", "pitch",
]);

// Whether a company's plan includes a feature. A company with no `features`
// array set (legacy / unpriced) gets EVERYTHING — so gating only kicks in once
// a plan is assigned. A suspended company loses everything but the basics.
export function hasFeature(company: Company | null | undefined, key: FeatureKey): boolean {
  if (!company) return true;
  if (company.billingExempt) return true; // comped → everything on
  if (company.status === "suspended" && key !== "map") return false;
  if (!Array.isArray(company.features)) return true;
  if (company.features.includes(key)) return true;
  return !COMPANY_GATED.has(key); // newer service keys default on
}

// RallyCard (digital card, lead capture, and — layered on top of the existing
// rewards/chat/scheduling services — recruiting/competitions) can be sold as
// its own product: a company whose plan omits "map" gets ONLY the RallyCard
// surface (no canvassing map/movers/territories/etc.), while every existing
// company keeps the full platform exactly as today (map is on by default).
export function isRallyCardOnly(company: Company | null | undefined): boolean {
  return !hasFeature(company, "map");
}

// Service keys the admin console's "Company services" / "Team services"
// checkboxes manage. The company-wide baseline is only enforced for these (so
// keys outside this set — e.g. pitch, card — are never accidentally gated by it).
const BASELINE_KEYS = new Set<string>([
  "map", "skiptrace", "scheduling", "calendar", "chat", "analytics", "rewards", "planner",
  "battery", "voice", "historical", "aiRecommend", "aiTerritories", "movers", "leads", "team",
]);

// Effective per-USER access: the company plan AND the company-wide services
// baseline AND, when configured, the user's position + team services.
//
// `companyServices` is the admin console's "Company services" umbrella baseline —
// a hard company-wide ceiling for EVERYONE (admins included): if it's configured
// and a service isn't in it, that service is off for the whole company (e.g.
// unchecking "Battery tool & proposal" removes the Battery Tool + Sold Projects
// everywhere). When it's null/empty, there's no company-wide restriction.
//
// Team services are a per-team restriction on top of that; the position adds to
// them. When nothing is configured, there's no extra restriction — today's
// behavior. Admins see everything the company still has.
export function userHasService(
  company: Company | null | undefined,
  profile: UserProfile | null | undefined,
  team: Team | null | undefined,
  key: FeatureKey,
  companyServices?: string[] | null,
): boolean {
  if (!hasFeature(company, key)) return false;
  // Company-wide baseline (umbrella "Company services"): a hard ceiling for all.
  if (BASELINE_KEYS.has(key) && Array.isArray(companyServices) && companyServices.length > 0 && !companyServices.includes(key)) {
    return false;
  }
  const pos = profile?.position;
  if (profile?.role === "admin" || pos === "admin") return true;
  const ps = company?.positionServices;
  const granted = ps && pos && Array.isArray(ps[pos]) ? ps[pos] : null;
  const teamKeys = Array.isArray(team?.servicePermissions) ? team!.servicePermissions! : [];
  if (!granted && teamKeys.length === 0) return true; // unconfigured → no restriction
  return (granted?.includes(key) ?? false) || teamKeys.includes(key);
}
