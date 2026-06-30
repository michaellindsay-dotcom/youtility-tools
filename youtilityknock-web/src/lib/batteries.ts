// Battery sales toolkit — the deterministic "brains" behind the closer's battery
// proposal tool: a manufacturer-spec product catalog, an appliance/load library,
// a bill analyzer, and a load + battery sizing engine. Pure functions only so the
// math is testable and the UI stays thin.

// ── Product catalog (manufacturer specs) ─────────────────────────────────────
// usableKWh = usable energy per unit; continuousKW = continuous backup power per
// unit; peakKW = 10-second motor-start surge per unit; maxUnits = how many stack
// in one system. Specs are nameplate figures published by each manufacturer
// (approximate, kept current as of 2025 — admin-editable catalog comes later).
export interface BatteryProduct {
  id: string;
  brand: string;
  model: string;
  usableKWh: number;
  continuousKW: number;
  peakKW: number;
  maxUnits: number;
  chemistry: "LFP" | "NMC";
  roundTrip: number; // round-trip efficiency, 0–1
  warrantyYears: number;
  acCoupled: boolean; // true = AC-coupled (works with any existing solar)
  notes?: string;
}

export const BATTERIES: BatteryProduct[] = [
  { id: "tesla_pw3", brand: "Tesla", model: "Powerwall 3", usableKWh: 13.5, continuousKW: 11.5, peakKW: 11.5, maxUnits: 4, chemistry: "LFP", roundTrip: 0.89, warrantyYears: 10, acCoupled: false, notes: "Integrated solar inverter (up to 20 kW PV). Best for new solar + battery." },
  { id: "tesla_pw2", brand: "Tesla", model: "Powerwall 2", usableKWh: 13.5, continuousKW: 5.8, peakKW: 10, maxUnits: 10, chemistry: "NMC", roundTrip: 0.90, warrantyYears: 10, acCoupled: true, notes: "AC-coupled — pairs with existing solar." },
  { id: "franklin_apower2", brand: "FranklinWH", model: "aPower 2", usableKWh: 15, continuousKW: 10, peakKW: 22.5, maxUnits: 10, chemistry: "LFP", roundTrip: 0.89, warrantyYears: 15, acCoupled: true, notes: "High surge (22.5 kW) — great for well pumps / AC starts. 15-yr warranty." },
  { id: "franklin_apower", brand: "FranklinWH", model: "aPower", usableKWh: 13.6, continuousKW: 5, peakKW: 10, maxUnits: 10, chemistry: "LFP", roundTrip: 0.89, warrantyYears: 12, acCoupled: true },
  { id: "enphase_5p", brand: "Enphase", model: "IQ Battery 5P", usableKWh: 5.0, continuousKW: 3.84, peakKW: 7.68, maxUnits: 8, chemistry: "LFP", roundTrip: 0.90, warrantyYears: 15, acCoupled: true, notes: "Modular — fine granularity for right-sizing. AC-coupled." },
  { id: "enphase_10c", brand: "Enphase", model: "IQ Battery 10C", usableKWh: 10.0, continuousKW: 7.08, peakKW: 14.16, maxUnits: 4, chemistry: "LFP", roundTrip: 0.90, warrantyYears: 15, acCoupled: true },
  { id: "solaredge_home", brand: "SolarEdge", model: "Home Battery 10kWh", usableKWh: 9.7, continuousKW: 5, peakKW: 7.5, maxUnits: 3, chemistry: "NMC", roundTrip: 0.945, warrantyYears: 10, acCoupled: false },
  { id: "lg_resu16", brand: "LG", model: "RESU16H Prime", usableKWh: 16.0, continuousKW: 7, peakKW: 11, maxUnits: 2, chemistry: "NMC", roundTrip: 0.90, warrantyYears: 10, acCoupled: false },
  { id: "panasonic_evervolt", brand: "Panasonic", model: "EverVolt 2.0", usableKWh: 17.1, continuousKW: 7.6, peakKW: 9.6, maxUnits: 3, chemistry: "NMC", roundTrip: 0.90, warrantyYears: 12, acCoupled: true },
  { id: "generac_pwrcell", brand: "Generac", model: "PWRcell M6", usableKWh: 18.0, continuousKW: 9, peakKW: 9, maxUnits: 2, chemistry: "NMC", roundTrip: 0.965, warrantyYears: 10, acCoupled: false, notes: "Modular DC-coupled stack." },
];

export const batteryById = (id: string) => BATTERIES.find((b) => b.id === id);

// ── Per-product marketing content + 3D shape ─────────────────────────────────
// Drives the CRM-style proposal (tagline + features + benefits matching the
// selected battery) and the interactive 3D/AR model (brand accent + real-world
// proportions in meters, W×H×D, so the rendered unit looks like the real thing).
export interface BatteryContent {
  tagline: string;
  features: string[]; // spec-y bullets ("what it is")
  benefits: string[]; // homeowner outcomes ("what it does for you")
  accent: string; // brand accent color
  dims: { w: number; h: number; d: number }; // meters, for the 3D model proportions
}
export const BATTERY_CONTENT: Record<string, BatteryContent> = {
  tesla_pw3: {
    tagline: "The all-in-one powerhouse with solar built in.",
    features: ["13.5 kWh usable", "11.5 kW continuous — runs the whole home", "Integrated solar inverter (up to 20 kW PV)", "LFP — safe, long-life chemistry", "10-year warranty"],
    benefits: ["Run your entire home, not just a few circuits", "Fewer parts on the wall — one sleek unit", "Start motors & AC without a flicker", "Expand to 4 units as your needs grow"],
    accent: "#E82127", dims: { w: 0.61, h: 1.1, d: 0.19 },
  },
  tesla_pw2: {
    tagline: "The proven classic — pairs with any existing solar.",
    features: ["13.5 kWh usable", "5.8 kW continuous", "AC-coupled — works with your current solar", "10-year warranty", "Stack up to 10 units"],
    benefits: ["Add storage without replacing your solar", "Keep essentials running through outages", "A battery with millions of installs behind it"],
    accent: "#E82127", dims: { w: 0.75, h: 1.15, d: 0.15 },
  },
  franklin_apower2: {
    tagline: "Heavy-duty backup with the muscle for well pumps & AC.",
    features: ["15 kWh usable — most in class", "10 kW continuous / 22.5 kW surge", "LFP chemistry", "15-year warranty", "Stack up to 10 units"],
    benefits: ["Start the biggest motors in your home", "More backup hours per unit", "Industry-leading 15-year peace of mind"],
    accent: "#0091DA", dims: { w: 0.7, h: 1.12, d: 0.28 },
  },
  franklin_apower: {
    tagline: "Reliable whole-home storage, built to last.",
    features: ["13.6 kWh usable", "5 kW continuous / 10 kW surge", "LFP chemistry", "12-year warranty", "AC-coupled"],
    benefits: ["Dependable backup for your essentials", "Pairs with existing or new solar", "Long-life LFP cells"],
    accent: "#0091DA", dims: { w: 0.68, h: 1.08, d: 0.27 },
  },
  enphase_5p: {
    tagline: "Modular storage — size it exactly to your home.",
    features: ["5.0 kWh usable per unit", "3.84 kW continuous", "LFP chemistry", "15-year warranty", "Stack up to 8 units"],
    benefits: ["Right-size now, add more later", "No single point of failure — each unit is independent", "One of the longest warranties in storage"],
    accent: "#F3901D", dims: { w: 0.42, h: 0.4, d: 0.22 },
  },
  enphase_10c: {
    tagline: "Bigger modular blocks, same bulletproof design.",
    features: ["10.0 kWh usable per unit", "7.08 kW continuous", "LFP chemistry", "15-year warranty"],
    benefits: ["Fewer units for more capacity", "Microinverter reliability you can trust", "Grows with your needs"],
    accent: "#F3901D", dims: { w: 0.66, h: 0.55, d: 0.31 },
  },
  solaredge_home: {
    tagline: "Tight integration with the SolarEdge ecosystem.",
    features: ["9.7 kWh usable", "5 kW continuous", "94.5% round-trip efficiency", "10-year warranty"],
    benefits: ["Excellent efficiency — more of your solar kept", "One app for solar + storage", "Clean, compact footprint"],
    accent: "#E4002B", dims: { w: 0.54, h: 1.13, d: 0.25 },
  },
  lg_resu16: {
    tagline: "High-capacity storage in a slim footprint.",
    features: ["16.0 kWh usable", "7 kW continuous", "10-year warranty", "Compact wall mount"],
    benefits: ["Lots of backup from a single unit", "Slim profile for tight installs", "Trusted global battery maker"],
    accent: "#A50034", dims: { w: 0.74, h: 1.06, d: 0.21 },
  },
  panasonic_evervolt: {
    tagline: "Big, flexible capacity from a name you know.",
    features: ["17.1 kWh usable", "7.6 kW continuous", "AC-coupled", "12-year warranty"],
    benefits: ["Among the most capacity per unit", "Works with new or existing solar", "Backed by Panasonic reliability"],
    accent: "#0039A6", dims: { w: 0.66, h: 1.1, d: 0.31 },
  },
  generac_pwrcell: {
    tagline: "Expandable DC-coupled stack for serious capacity.",
    features: ["18.0 kWh usable", "9 kW continuous", "96.5% round-trip efficiency", "10-year warranty"],
    benefits: ["Top-tier efficiency keeps more solar", "Scale capacity in modules", "Generator-grade backup heritage"],
    accent: "#F58220", dims: { w: 0.66, h: 1.18, d: 0.31 },
  },
};
const FALLBACK_CONTENT: BatteryContent = {
  tagline: "Reliable home energy storage.",
  features: ["Usable backup capacity", "Whole-home or essentials backup", "Long-life chemistry"],
  benefits: ["Keep the lights on during outages", "Store solar for the evening", "Lower your reliance on the grid"],
  accent: "#8b5cf6", dims: { w: 0.6, h: 1.05, d: 0.2 },
};
export const batteryContent = (id: string): BatteryContent => BATTERY_CONTENT[id] || FALLBACK_CONTENT;

// ── Appliance / load library ─────────────────────────────────────────────────
// runningW = steady draw; startingW = motor inrush surge; hoursPerDay = typical
// daily runtime used for the energy estimate. `essential` ones default on for an
// essentials-only backup. Figures are typical residential values.
export type LoadCategory = "Essentials" | "HVAC" | "Kitchen" | "Laundry" | "Water" | "EV" | "Other";

export interface Appliance {
  id: string;
  name: string;
  category: LoadCategory;
  runningW: number;
  startingW: number;
  hoursPerDay: number;
  essential?: boolean;
  motor?: boolean;
}

export const APPLIANCES: Appliance[] = [
  // Essentials
  { id: "fridge", name: "Refrigerator", category: "Essentials", runningW: 150, startingW: 1200, hoursPerDay: 8, essential: true, motor: true },
  { id: "freezer", name: "Chest freezer", category: "Essentials", runningW: 150, startingW: 1100, hoursPerDay: 6, essential: true, motor: true },
  { id: "lights", name: "LED lighting (whole home)", category: "Essentials", runningW: 200, startingW: 200, hoursPerDay: 5, essential: true },
  { id: "outlets", name: "Outlets / small electronics", category: "Essentials", runningW: 300, startingW: 300, hoursPerDay: 6, essential: true },
  { id: "internet", name: "Wi-Fi / modem / router", category: "Essentials", runningW: 40, startingW: 40, hoursPerDay: 24, essential: true },
  { id: "sump", name: "Sump pump", category: "Essentials", runningW: 800, startingW: 2400, hoursPerDay: 2, motor: true },
  { id: "garage", name: "Garage door opener", category: "Essentials", runningW: 550, startingW: 1400, hoursPerDay: 0.2, motor: true },
  { id: "medical", name: "Medical device (CPAP/O2)", category: "Essentials", runningW: 200, startingW: 200, hoursPerDay: 8 },
  // HVAC
  { id: "furnace_fan", name: "Furnace blower (gas heat)", category: "HVAC", runningW: 800, startingW: 2350, hoursPerDay: 8, motor: true },
  { id: "ac_3ton", name: "Central AC (3-ton)", category: "HVAC", runningW: 3500, startingW: 11000, hoursPerDay: 6, motor: true },
  { id: "heatpump", name: "Heat pump (3-ton)", category: "HVAC", runningW: 4000, startingW: 12000, hoursPerDay: 8, motor: true },
  { id: "miniSplit", name: "Mini-split (per head)", category: "HVAC", runningW: 1200, startingW: 1800, hoursPerDay: 8, motor: true },
  { id: "spaceHeater", name: "Space heater", category: "HVAC", runningW: 1500, startingW: 1500, hoursPerDay: 4 },
  // Kitchen
  { id: "microwave", name: "Microwave", category: "Kitchen", runningW: 1000, startingW: 1000, hoursPerDay: 0.5 },
  { id: "range", name: "Electric range/oven", category: "Kitchen", runningW: 3000, startingW: 3000, hoursPerDay: 1 },
  { id: "dishwasher", name: "Dishwasher", category: "Kitchen", runningW: 1200, startingW: 1400, hoursPerDay: 1, motor: true },
  // Laundry
  { id: "washer", name: "Washing machine", category: "Laundry", runningW: 1000, startingW: 1400, hoursPerDay: 0.7, motor: true },
  { id: "dryer_e", name: "Electric dryer", category: "Laundry", runningW: 3000, startingW: 3300, hoursPerDay: 0.7, motor: true },
  // Water
  { id: "well", name: "Well pump (1 HP)", category: "Water", runningW: 1500, startingW: 4500, hoursPerDay: 2, motor: true },
  { id: "waterHeater_e", name: "Electric water heater", category: "Water", runningW: 4500, startingW: 4500, hoursPerDay: 3 },
  // EV
  { id: "ev_l2", name: "EV charger (Level 2)", category: "EV", runningW: 7200, startingW: 7200, hoursPerDay: 3 },
];

export const appliancesByCategory = () => {
  const map = new Map<LoadCategory, Appliance[]>();
  for (const a of APPLIANCES) {
    const arr = map.get(a.category) || [];
    arr.push(a);
    map.set(a.category, arr);
  }
  return map;
};

// ── Bill analyzer ────────────────────────────────────────────────────────────
// Normalizes whatever the rep has from the homeowner's bill into a consistent
// usage + rate picture. Any two of {monthlyKWh, monthlyCost, ratePerKWh} derive
// the third; falls back to typical US figures so the tool always produces output.
export interface BillInput {
  monthlyKWh?: number;
  monthlyCost?: number;
  ratePerKWh?: number;
}
export interface BillAnalysis {
  monthlyKWh: number;
  monthlyCost: number;
  ratePerKWh: number;
  dailyKWh: number;
  annualKWh: number;
  annualCost: number;
  source: "complete" | "derived" | "estimated";
}
export function analyzeBill(input: BillInput): BillAnalysis {
  let { monthlyKWh, monthlyCost, ratePerKWh } = input;
  let source: BillAnalysis["source"] = "complete";
  if (monthlyKWh && monthlyCost && !ratePerKWh) ratePerKWh = monthlyCost / monthlyKWh;
  else if (monthlyKWh && ratePerKWh && !monthlyCost) { monthlyCost = monthlyKWh * ratePerKWh; source = "derived"; }
  else if (monthlyCost && ratePerKWh && !monthlyKWh) { monthlyKWh = monthlyCost / ratePerKWh; source = "derived"; }
  else if (monthlyKWh && monthlyCost && ratePerKWh) source = "complete";
  else source = "estimated";
  const rate = ratePerKWh && ratePerKWh > 0 ? ratePerKWh : 0.17; // US avg ≈ $0.17/kWh
  const kwh = monthlyKWh && monthlyKWh > 0 ? monthlyKWh : 900; // US avg ≈ 900 kWh/mo
  const cost = monthlyCost && monthlyCost > 0 ? monthlyCost : kwh * rate;
  return {
    monthlyKWh: round1(kwh),
    monthlyCost: round2(cost),
    ratePerKWh: round3(rate),
    dailyKWh: round1(kwh / 30),
    annualKWh: Math.round(kwh * 12),
    annualCost: round2(cost * 12),
    source,
  };
}

// ── Existing solar (manual entry; live monitoring-app sync is a future step) ───
export interface SolarInput {
  hasSolar: boolean;
  systemKwDc?: number; // array size
  annualProductionKWh?: number; // from the monitoring app, if the homeowner has it
}
// Estimate daily solar production when only the array size is known (~4 sun-hours
// derate is a reasonable national average; the monitoring-app figure is preferred).
export function estimateSolarDailyKWh(s: SolarInput): number {
  if (!s.hasSolar) return 0;
  if (s.annualProductionKWh && s.annualProductionKWh > 0) return round1(s.annualProductionKWh / 365);
  if (s.systemKwDc && s.systemKwDc > 0) return round1(s.systemKwDc * 4 * 0.85);
  return 0;
}

// ── Load calculator ──────────────────────────────────────────────────────────
export interface SelectedLoad { applianceId: string; qty: number; hoursPerDay?: number }
export interface LoadResult {
  dailyKWh: number; // energy the selected loads use per day
  runningKW: number; // sum of running watts (all selected on)
  continuousKW: number; // continuous power the battery must sustain
  peakKW: number; // worst-case motor-start surge
  items: Array<{ name: string; qty: number; runningW: number; startingW: number; dailyKWh: number }>;
}
// diversity = simultaneity factor: not everything runs at once. 1.0 = conservative
// (everything on together); ~0.6 is realistic for a whole-home selection.
export function computeLoad(selected: SelectedLoad[], diversity = 1): LoadResult {
  let runningW = 0;
  let dailyWh = 0;
  let maxSurgeDelta = 0; // extra watts the biggest motor adds when it starts
  const items: LoadResult["items"] = [];
  for (const sel of selected) {
    const a = APPLIANCES.find((x) => x.id === sel.applianceId);
    if (!a || sel.qty <= 0) continue;
    const run = a.runningW * sel.qty;
    const hours = sel.hoursPerDay ?? a.hoursPerDay;
    const dWh = a.runningW * sel.qty * hours;
    runningW += run;
    dailyWh += dWh;
    // Surge delta for one unit of this appliance starting while others run.
    maxSurgeDelta = Math.max(maxSurgeDelta, (a.startingW - a.runningW));
    items.push({ name: a.name, qty: sel.qty, runningW: run, startingW: a.startingW * sel.qty, dailyKWh: round2(dWh / 1000) });
  }
  const continuousW = runningW * diversity;
  return {
    dailyKWh: round1(dailyWh / 1000),
    runningKW: round2(runningW / 1000),
    continuousKW: round2(continuousW / 1000),
    peakKW: round2((continuousW + maxSurgeDelta) / 1000),
    items,
  };
}

// ── Battery recommendation engine ────────────────────────────────────────────
export type SizingGoal = "backup" | "savings" | "both";
export interface SizingInput {
  load: LoadResult;
  goal: SizingGoal;
  backupDays: number; // desired days of essential autonomy
  dailyUsageKWh?: number; // from the bill — drives the savings (self-consumption) target
  solarDailyKWh?: number; // existing/proposed solar offsets autonomy needs
  preferLFP?: boolean; // homeowner preference for LFP chemistry
}
export interface RecommendedSystem {
  product: BatteryProduct;
  units: number;
  totalUsableKWh: number;
  totalContinuousKW: number;
  totalPeakKW: number;
  energyTargetKWh: number;
  backupDaysAchieved: number; // days the recommended system covers the essential load
  meetsContinuous: boolean;
  meetsSurge: boolean;
  fit: "ideal" | "good" | "undersized";
  score: number;
}
// The usable-kWh target the system should hit, from the homeowner's goal.
function energyTargetFor(input: SizingInput): number {
  const { load, goal, backupDays } = input;
  const dailyUse = input.dailyUsageKWh && input.dailyUsageKWh > 0 ? input.dailyUsageKWh : load.dailyKWh;
  const solar = Math.max(0, input.solarDailyKWh || 0);
  // Net daily backup load after solar recharges the battery during an outage.
  const netDailyBackup = Math.max(load.dailyKWh - solar * 0.6, load.dailyKWh * 0.35);
  const backupEnergy = netDailyBackup * Math.max(backupDays, 0.5);
  const savingsEnergy = dailyUse * 0.5; // self-consumption / TOU: shift the evening half
  return goal === "savings" ? savingsEnergy : goal === "both" ? Math.max(backupEnergy, savingsEnergy) : backupEnergy;
}

// Evaluate a specific product at a specific unit count — the single source of
// truth for totals, fit, backup days and score. Used both for the auto
// recommendation and when a rep overrides the quantity in the proposal. Units
// are clamped to [1, product.maxUnits].
export function systemForUnits(product: BatteryProduct, requestedUnits: number, input: SizingInput): RecommendedSystem {
  const { load, backupDays } = input;
  const solar = Math.max(0, input.solarDailyKWh || 0);
  const energyTarget = energyTargetFor(input);
  const units = Math.min(Math.max(1, Math.round(requestedUnits || 1)), product.maxUnits);
  const totalUsableKWh = round1(product.usableKWh * units);
  const totalContinuousKW = round1(product.continuousKW * units);
  const totalPeakKW = round1(product.peakKW * units);
  const meetsContinuous = totalContinuousKW + 1e-6 >= load.continuousKW;
  const meetsSurge = totalPeakKW + 1e-6 >= load.peakKW;
  const meetsEnergy = totalUsableKWh + 1e-6 >= energyTarget;
  const backupDaysAchieved = load.dailyKWh > 0 ? round1((totalUsableKWh + solar * 0.6 * Math.max(backupDays, 1)) / load.dailyKWh) : 0;
  const fit: RecommendedSystem["fit"] =
    meetsEnergy && meetsContinuous && meetsSurge ? (totalUsableKWh <= energyTarget * 1.4 ? "ideal" : "good") : "undersized";
  // Score: prefer systems that meet all needs, with the least overshoot and
  // fewest units; nudge for LFP preference and longer warranty.
  let score = 0;
  if (meetsEnergy) score += 50;
  if (meetsContinuous) score += 20;
  if (meetsSurge) score += 15;
  score -= Math.abs(totalUsableKWh - energyTarget) * 1.5;
  score -= (units - 1) * 2;
  score += product.warrantyYears * 0.4;
  if (input.preferLFP && product.chemistry === "LFP") score += 6;
  return {
    product, units, totalUsableKWh, totalContinuousKW, totalPeakKW,
    energyTargetKWh: round1(energyTarget), backupDaysAchieved,
    meetsContinuous, meetsSurge, fit, score: round1(score),
  };
}

// Rank candidate systems. `products` defaults to the full catalog; pass the
// company's offered subset to limit what a rep can propose.
export function recommendSystems(input: SizingInput, products: BatteryProduct[] = BATTERIES): RecommendedSystem[] {
  const energyTarget = energyTargetFor(input);
  return products.map((p) => {
    const byEnergy = Math.ceil(energyTarget / p.usableKWh);
    const byPower = Math.ceil(input.load.continuousKW / p.continuousKW);
    return systemForUnits(p, Math.max(1, byEnergy, byPower), input);
  }).sort((a, b) => b.score - a.score);
}

// ── Pricing & ROI ────────────────────────────────────────────────────────────
// Per-company catalog pricing (admin-set) with a per-proposal override. There is
// NO federal ITC — savings come from incentive-adjusted net cost + bill savings.
export interface PricingEntry { price: number; adder: number } // price per unit, fixed install adder
export interface ROIInput {
  rec: RecommendedSystem;
  pricePerUnit: number;
  installAdder: number;
  incentivesTotalUsd: number; // sum of the incentives the rep marked as applicable
  ratePerKWh: number;
  dailyUsageKWh?: number; // from the bill — caps how much the battery can shift
}
export interface ROIResult {
  grossCost: number;
  incentives: number;
  netCost: number;
  monthlySavings: number;
  annualSavings: number;
  lifetimeSavings: number; // over the product's warranty period
  warrantyYears: number;
}
export function computeROI(input: ROIInput): ROIResult {
  const { rec, pricePerUnit, installAdder, incentivesTotalUsd, ratePerKWh } = input;
  const grossCost = round2(pricePerUnit * rec.units + installAdder);
  const incentives = round2(Math.min(Math.max(incentivesTotalUsd, 0), grossCost)); // can't exceed cost
  const netCost = round2(Math.max(0, grossCost - incentives));
  // Daily energy the battery realistically shifts (self-consumption / TOU), capped
  // by usable capacity and the home's daily usage, derated by round-trip losses.
  const dailyUse = input.dailyUsageKWh && input.dailyUsageKWh > 0 ? input.dailyUsageKWh : rec.totalUsableKWh;
  const dailyShift = Math.min(rec.totalUsableKWh, dailyUse * 0.6);
  const monthlySavings = round2(dailyShift * 30 * ratePerKWh * rec.product.roundTrip);
  const annualSavings = round2(monthlySavings * 12);
  const lifetimeSavings = round2(annualSavings * rec.product.warrantyYears);
  return { grossCost, incentives, netCost, monthlySavings, annualSavings, lifetimeSavings, warrantyYears: rec.product.warrantyYears };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function round1(n: number) { return Math.round(n * 10) / 10; }
function round2(n: number) { return Math.round(n * 100) / 100; }
function round3(n: number) { return Math.round(n * 1000) / 1000; }
