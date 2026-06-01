import type { RewardMetric, RewardPeriod, UserStats } from "../types";
import { computePoints, PTS } from "./points";

export const METRIC_LABEL: Record<RewardMetric, string> = {
  points: "Points",
  doors: "Doors",
  conversations: "Conversations",
  appointments: "Appointments",
  sales: "Closes",
};
export const METRIC_EMOJI: Record<RewardMetric, string> = {
  points: "⭐", doors: "🚪", conversations: "💬", appointments: "📅", sales: "💰",
};
export const PERIOD_LABEL: Record<RewardPeriod, string> = {
  weekly: "this week", monthly: "this month", alltime: "all-time",
};

export interface MetricVals {
  points: number; doors: number; conversations: number; appointments: number; sales: number;
}

export const ZERO_VALS: MetricVals = { points: 0, doors: 0, conversations: 0, appointments: 0, sales: 0 };

// Build a metric bundle from raw counts (windowed) — points via the shared model.
export function valsFromCounts(c: { doors: number; conv: number; appt: number; sales: number; shifts: number }): MetricVals {
  const pseudo: Partial<UserStats> = {
    doorsKnocked: c.doors, leadsCreated: c.conv, appointments: c.appt, sales: c.sales, shifts: c.shifts,
  };
  return {
    points: computePoints(pseudo),
    doors: c.doors, conversations: c.conv, appointments: c.appt, sales: c.sales,
  };
}

export function valsFromStats(s: Partial<UserStats>): MetricVals {
  return {
    points: computePoints(s),
    doors: s.doorsKnocked ?? 0,
    conversations: s.leadsCreated ?? 0,
    appointments: s.appointments ?? 0,
    sales: s.sales ?? 0,
  };
}

export { PTS };
