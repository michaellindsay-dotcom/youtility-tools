import type { UserStats } from "../types";

// ── The points economy ───────────────────────────────────────────────────────
// Every tracked action is worth points. Tuned so closing is king, but grinding
// doors and showing up (shifts) still moves you up the board.
export const PTS = {
  door: 1, // each knock
  lead: 3, // a real conversation / lead logged
  appointment: 20, // booked appointment
  sale: 100, // closed deal 💰
  shift: 25, // showing up & working a shift
} as const;

export interface PointLine { key: string; label: string; emoji: string; per: number; count: number; total: number; }

// Per-stat point breakdown (drives the "how points work" legend + tooltips).
export function pointLines(s: Partial<UserStats>): PointLine[] {
  return [
    { key: "sale", label: "Closes", emoji: "💰", per: PTS.sale, count: s.sales ?? 0, total: (s.sales ?? 0) * PTS.sale },
    { key: "appointment", label: "Appointments", emoji: "📅", per: PTS.appointment, count: s.appointments ?? 0, total: (s.appointments ?? 0) * PTS.appointment },
    { key: "shift", label: "Shifts", emoji: "⏱️", per: PTS.shift, count: s.shifts ?? 0, total: (s.shifts ?? 0) * PTS.shift },
    { key: "lead", label: "Conversations", emoji: "💬", per: PTS.lead, count: s.leadsCreated ?? 0, total: (s.leadsCreated ?? 0) * PTS.lead },
    { key: "door", label: "Doors", emoji: "🚪", per: PTS.door, count: s.doorsKnocked ?? 0, total: (s.doorsKnocked ?? 0) * PTS.door },
  ];
}

export function computePoints(s: Partial<UserStats>): number {
  return pointLines(s).reduce((sum, l) => sum + l.total, 0);
}

// ── Levels & tiers ────────────────────────────────────────────────────────────
export const LEVEL_PTS = 750;

export function levelInfo(points: number) {
  const level = Math.floor(points / LEVEL_PTS) + 1;
  const into = points % LEVEL_PTS;
  return { level, into, toNext: LEVEL_PTS - into, pct: Math.round((into / LEVEL_PTS) * 100) };
}

export interface Tier { name: string; emoji: string; color: string; }
export function tierFor(level: number): Tier {
  if (level >= 15) return { name: "Legend", emoji: "👑", color: "#FBBF24" };
  if (level >= 10) return { name: "Elite", emoji: "🔥", color: "#F87171" };
  if (level >= 6) return { name: "Pro", emoji: "⭐", color: "#A78BFA" };
  if (level >= 3) return { name: "Closer", emoji: "🔑", color: "#38BDF8" };
  return { name: "Rookie", emoji: "🥾", color: "#34D399" };
}

// ── Cosmetic helpers ──────────────────────────────────────────────────────────
export function initials(name?: string): string {
  const parts = (name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

// Stable color from a string (for avatar backgrounds).
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 45%)`;
}
