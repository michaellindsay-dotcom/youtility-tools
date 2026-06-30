// Energy-incentive discovery — local / AHJ / electric-utility battery + solar
// incentives for an address. The backend (getAreaIncentives) identifies the
// utility via NREL and researches current programs via Claude web search, so
// every incentive carries real dates + a verification link. Shared by the
// battery proposal tool, the setter's customer card, and the closer.
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

export interface AreaIncentive {
  name: string;
  administrator?: string;
  level?: "utility" | "state" | "county" | "city" | "ahj" | "other";
  type?: "rebate" | "tax" | "performance" | "financing" | "exemption";
  amount?: string;
  estValueUsd?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  url?: string;
  summary?: string;
}

export interface IncentiveReport {
  location: string;
  state?: string | null;
  zip?: string | null;
  utility?: { name: string; rate: number | null } | null;
  incentives: AreaIncentive[];
  sources: { url: string; title: string }[];
  usedWeb: boolean;
  generatedAt: number;
  cacheId: string;
  cached: boolean;
}

export interface IncentiveQuery {
  lat?: number;
  lng?: number;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  refresh?: boolean;
}

export async function fetchAreaIncentives(input: IncentiveQuery): Promise<IncentiveReport> {
  const r = await httpsCallable(functions, "getAreaIncentives")(input);
  return r.data as IncentiveReport;
}

// Sum the dollar estimates the rep is counting toward net cost.
export const incentiveTotalUsd = (items: AreaIncentive[] | undefined) =>
  (items || []).reduce((s, i) => s + (typeof i.estValueUsd === "number" ? i.estValueUsd : 0), 0);

// "Jan 2025 – ongoing" style window for display.
export const incentiveDates = (i: AreaIncentive) =>
  [i.startDate, i.endDate].filter(Boolean).join(" – ") || "see source";
