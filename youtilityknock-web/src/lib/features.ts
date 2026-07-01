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

// Effective per-USER access: the company plan AND, when configured, the user's
// position + team services. Team services are a locked baseline; the position
// adds to them. When nothing is configured (no positionServices for the user's
// position and no team services), there's no extra restriction — exactly today's
// behavior. Admins always see everything the company has.
export function userHasService(
  company: Company | null | undefined,
  profile: UserProfile | null | undefined,
  team: Team | null | undefined,
  key: FeatureKey,
): boolean {
  if (!hasFeature(company, key)) return false;
  const pos = profile?.position;
  if (profile?.role === "admin" || pos === "admin") return true;
  const ps = company?.positionServices;
  const granted = ps && pos && Array.isArray(ps[pos]) ? ps[pos] : null;
  const teamKeys = Array.isArray(team?.servicePermissions) ? team!.servicePermissions! : [];
  if (!granted && teamKeys.length === 0) return true; // unconfigured → no restriction
  return (granted?.includes(key) ?? false) || teamKeys.includes(key);
}
