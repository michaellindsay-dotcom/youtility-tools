// Season helpers — bucket points into resetting weekly / monthly / yearly
// windows. Keys are stable strings so the same period always maps to one doc.
export type SeasonKind = "week" | "month" | "year";
export type SeasonView = "alltime" | SeasonKind;

export function periodKey(kind: SeasonKind, d = new Date()): string {
  if (kind === "year") return `${d.getFullYear()}`;
  if (kind === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  // ISO-8601 week number.
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt.getTime() - ys.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

// Doc id in the seasonStats collection: uid + a kind-prefixed period.
export function seasonDocId(uid: string, kind: SeasonKind, d = new Date()): string {
  return `${uid}__${kind[0].toUpperCase()}${periodKey(kind, d)}`;
}

export function startOfYear(d = new Date()): number {
  return new Date(d.getFullYear(), 0, 1).getTime();
}

// Active days in the current year since a user joined — used to prorate the
// yearly board so mid-year joiners aren't buried under full-year veterans.
export function activeDaysThisYear(joinedAt?: number | null): number {
  const yStart = startOfYear();
  const start = Math.max(yStart, Number(joinedAt) || yStart);
  const days = (Date.now() - start) / 86400000;
  return Math.max(1, Math.ceil(days));
}

export const SEASON_LABEL: Record<SeasonView, string> = {
  alltime: "All-time",
  week: "This Week",
  month: "This Month",
  year: "This Year",
};
