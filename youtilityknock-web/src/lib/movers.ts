// Shared "movers" (recent move-in) helpers used by both the dedicated Movers
// page and the main Map page: the distinctive pin icon, the move-in age → color
// bucketing, and the click-popup content. Keeping these here means the two maps
// render movers identically from one source of truth.
import L from "leaflet";
import type { MoverHome } from "./knockstat";

export type MoverWindow = 30 | 60 | 90;

// Default lookback for movers shown automatically on the main map.
export const MOVER_DAYS: MoverWindow = 90;

// Color per move-in age bucket. Newest movers stand out brightest — the
// freshest doors to knock — fading to amber, then red as they age out.
export const MOVER_BUCKETS: { max: MoverWindow; color: string; label: string }[] = [
  { max: 30, color: "#22C55E", label: "0–30 days" },
  { max: 60, color: "#F59E0B", label: "31–60 days" },
  { max: 90, color: "#EF4444", label: "61–90 days" },
];

const HOUSE_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="#fff"><path d="M12 3 3 10.5h2.4V21h5.1v-6h3v6h5.1V10.5H21z"/></svg>';

// Distinctive teardrop "drop-pin" with a house glyph and a pulsing halo — built
// to pop off the satellite map (and stand apart from the round gray home pins).
export function moverIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: "mover-pin",
    html:
      `<span class="mp-halo" style="background:${color}"></span>` +
      `<span class="mp-drop" style="background:${color}">${HOUSE_SVG}</span>`,
    iconSize: [34, 44],
    iconAnchor: [17, 40],
    popupAnchor: [0, -38],
  });
}

// Whole days between the sale date and today; Infinity if unparseable.
export function daysAgo(dateStr: string): number {
  const t = Date.parse(dateStr.replace(/\//g, "-"));
  if (isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400000);
}

// Color for a move-in this many days ago, or null if older than the widest
// window (i.e. not a "mover").
export function moverColor(d: number): string | null {
  for (const b of MOVER_BUCKETS) if (d <= b.max) return b.color;
  return null;
}

export function fmtMoveDate(dateStr: string): string {
  const t = Date.parse(dateStr.replace(/\//g, "-"));
  if (isNaN(t)) return dateStr;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Click-popup markup for a mover pin: just the move-in date.
export function moverPopupHtml(m: MoverHome): string {
  return (
    `<div class="mover-pop">` +
    `<div class="mp-row"><span>Moved in</span><b>${fmtMoveDate(m.saleDate)}</b></div>` +
    `</div>`
  );
}
