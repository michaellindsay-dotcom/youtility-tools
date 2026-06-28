import { useMemo, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// LivingEnergyScene — a photoreal, interactive "your home as a living energy
// system" centerpiece for the battery proposal. A real 3D-rendered home cutaway
// (rooftop solar + Sigen Gateway + SigenStor battery tower + EV in the garage +
// grid pole) sits behind an SVG overlay whose animated energy-flow lines are
// anchored to the actual components in the render. The homeowner picks a setup
// (Solar only / + Battery / + EV / Planning) and a mode (Self-consumption,
// Battery→Home, DC-charge EV, V2H outage, V2G, Grid pull…); the flows, live
// System-Status numbers, atmosphere (day/night/outage) and the explainer card
// all update together. Tapping any glowing hotspot explains that component.
//
// Ported from the hand-authored sigenstor_home.html (same render + flow geometry)
// into React so it lives inside the proposal, themes to the selected battery's
// accent, and is fed the customer's real usage. Self-contained: one <style>
// block, all classes prefixed `les-`.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const IMG = `${BASE}/proposal/home-ecosystem.jpg`;

type InfoCard = {
  theme: "solar" | "sigenstor" | "ev" | "v2g" | "charger" | "home" | "grid";
  tag: string;
  title: string; // may contain <em>
  body: string;
  spec: string; // may contain <strong>
};

type Stats = { solar: number; home: number; battery: number; ev: number; exportKW: number; importKW: number };

type Mode = InfoCard & { flows: string[]; stats: Stats; cable: boolean; atmo: "" | "night" | "outage" };

// ── Flow path geometry (anchored to the real render, viewBox 1600×817) ───────
type FlowDef = { id: string; d: string; stroke: string; width: number; reverse?: boolean };
const CABLE_D = "M 905,680 Q 920,695 940,695 L 1000,693 Q 1040,688 1055,620 Q 1060,600 1060,585";
const EV_CABLE_D =
  "M 875,560 L 905,680 Q 920,695 945,695 L 1005,693 Q 1040,688 1050,640 Q 1055,610 1055,590";
const FLOWS: FlowDef[] = [
  { id: "flow-solar-gw", d: "M 450,180 L 450,310 L 695,310 L 695,510", stroke: "#ffd86b", width: 3.5 },
  { id: "flow-gw-bat", d: "M 695,510 L 875,560", stroke: "#a78bfa", width: 3.5 },
  { id: "flow-bat-gw", d: "M 695,510 L 875,560", stroke: "#a78bfa", width: 3.5, reverse: true },
  { id: "flow-gw-home", d: "M 160,460 L 695,510", stroke: "#a78bfa", width: 3.5, reverse: true },
  { id: "flow-dcc-ev", d: EV_CABLE_D, stroke: "#8b5cf6", width: 4 },
  { id: "flow-ev-dcc", d: EV_CABLE_D, stroke: "#f472b6", width: 4, reverse: true },
  { id: "flow-ev-dcc-v2g", d: EV_CABLE_D, stroke: "#fb7185", width: 4, reverse: true },
  { id: "flow-bat-grid", d: "M 875,560 L 1540,420", stroke: "#38bdf8", width: 3.5 },
  { id: "flow-grid-bat", d: "M 875,560 L 1540,420", stroke: "#ef4444", width: 3.5, reverse: true },
  { id: "flow-bat-grid-v2g", d: "M 875,560 L 1540,420", stroke: "#fb7185", width: 3.5 },
  { id: "flow-gw-grid-surplus", d: "M 695,510 L 1540,420", stroke: "#38bdf8", width: 3 },
  { id: "flow-grid-gw-only", d: "M 695,510 L 1540,420", stroke: "#ef4444", width: 3.5, reverse: true },
];

// ── Hotspots (glowing dots on each real component) ───────────────────────────
type Hotspot = { key: keyof typeof HOTSPOT_CONTENT; x: number; y: number; color: string; label: string };
const HOTSPOTS: Hotspot[] = [
  { key: "solar", x: 450, y: 180, color: "#ffd86b", label: "SOLAR PV" },
  { key: "gateway", x: 695, y: 510, color: "#8b5cf6", label: "GATEWAY" },
  { key: "sigenstor", x: 875, y: 560, color: "#8b5cf6", label: "BATTERY" },
  { key: "ev", x: 1200, y: 570, color: "#f472b6", label: "EV" },
  { key: "home", x: 160, y: 460, color: "#ffb84d", label: "HOME" },
  { key: "grid", x: 1540, y: 420, color: "#ef4444", label: "GRID" },
];

const HOTSPOT_CONTENT: Record<string, InfoCard> = {
  solar: {
    theme: "solar",
    tag: "Rooftop PV Array",
    title: "The <em>source</em> — 8 to 12 kW on the roof",
    body: "Premium monocrystalline panels feed DC power directly into the battery's energy controller through independent MPPT channels. Complex roof layouts with multiple orientations still harvest maximum energy.",
    spec: "<strong>2:1 DC/AC ratio compatible.</strong> Oversize panels vs inverter for maximum solar harvest — every cloudy-morning watt counts.",
  },
  sigenstor: {
    theme: "sigenstor",
    tag: "5-in-1 Home ESS",
    title: "One stack. <em>Five devices in one.</em>",
    body: "Solar hybrid inverter, battery PCS, LiFePO₄ modules, a DC bi-directional EV charger, and the EMS brain — all in a single integrated tower. Every component speaks native DC on one bus, eliminating conversion losses.",
    spec: "<strong>Stackable modules</strong> deliver usable kWh and continuous kW per unit, stackable several high. High round-trip efficiency, ~0 ms backup transfer, weather-rated for indoor or outdoor install.",
  },
  gateway: {
    theme: "sigenstor",
    tag: "Smart Gateway",
    title: "The <em>smart manager</em> of the house",
    body: "The gateway is the communication and backup-management hub. It monitors every circuit, coordinates solar + battery + EV + grid, and handles the instant transfer when the utility goes down.",
    spec: "<strong>~0 ms transfer.</strong> Your computer doesn't reboot, your Wi-Fi doesn't drop, your medical equipment stays online. The neighbors lose power — you don't even notice.",
  },
  ev: {
    theme: "ev",
    tag: "Electric Vehicle · V2X Ready",
    title: "Your EV is a <em>75—130 kWh</em> mobile battery",
    body: "A modern EV carries 5—10× the capacity of a typical home battery. With bidirectional V2X, your car can power the home during outages, or discharge back to the grid for peak-rate revenue.",
    spec: "<strong>V2H &amp; V2G support</strong> depends on the vehicle. The DC module is upgradable over the air as new EVs get certified — F-150 Lightning, Kia EV9, Ioniq 5/6, and more.",
  },
  home: {
    theme: "home",
    tag: "The Load",
    title: "Your home, <em>unchanged</em> — except the bill",
    body: "The hybrid inverter converts DC from solar, battery, or EV into clean AC for your home. Lights, HVAC, heat pump, kitchen, EV charging — nothing changes in how you live. Everything changes on the utility bill.",
    spec: "<strong>A right-sized battery + solar</strong> offsets 90—110% of consumption, driving net bills toward zero.",
  },
  grid: {
    theme: "grid",
    tag: "Utility Connection",
    title: "The utility as your <em>backup</em>",
    body: "The grid connection becomes a safety net for the darkest stretches — and a revenue opportunity during peak demand hours. Storing and using your own energy is increasingly more valuable than exporting it.",
    spec: "<strong>Programmable reserve:</strong> set a minimum battery % (e.g. 20%) to hold back for outages. Never caught empty during a grid event.",
  },
};

const MODE_CONTENT: Record<string, Mode> = {
  self: {
    theme: "sigenstor",
    tag: "Default · Daytime Operation",
    title: "<em>Self Consumption</em> — use your own sun first",
    body: "Solar DC drops down the wall into the gateway, which feeds the home and banks any surplus in the battery tower. Every watt displaces a retail-rate kWh from the utility.",
    spec: "<strong>Highest-value mode.</strong> You displace retail-rate grid power with panels you already own, and bank the surplus for tonight.",
    flows: ["flow-solar-gw", "flow-gw-home", "flow-gw-bat"],
    stats: { solar: 7.4, home: 2.1, battery: 68, ev: 82, exportKW: 0, importKW: 0 },
    cable: false,
    atmo: "",
  },
  "battery-home": {
    theme: "sigenstor",
    tag: "Evening / Night Operation",
    title: "Battery <em>powers the home</em> after sunset",
    body: "Solar's done for the day. The battery pushes stored DC up to the gateway, which converts to AC and delivers it to every circuit in the home. The utility doesn't know you exist.",
    spec: "<strong>High continuous discharge</strong> from a multi-module stack — enough for central AC + kitchen + lights simultaneously.",
    flows: ["flow-bat-gw", "flow-gw-home"],
    stats: { solar: 0, home: 3.2, battery: 54, ev: 82, exportKW: 0, importKW: 0 },
    cable: false,
    atmo: "night",
  },
  "ev-charge": {
    theme: "charger",
    tag: "DC-DC Direct Charging",
    title: "Charge your EV <em>DC-to-DC</em> from the sun",
    body: "Solar enters the gateway, which feeds the home. Surplus drops into the battery tower, and the DC charger module at the base sends power straight out the cable to the vehicle — no AC conversion, no onboard converter loss.",
    spec: "<strong>Up to 25 kW DC.</strong> Roughly 3× faster than a typical Level-2 AC charger, with less conversion loss. Empty EV to 80% in a single sunny afternoon.",
    flows: ["flow-solar-gw", "flow-gw-home", "flow-gw-bat", "flow-dcc-ev"],
    stats: { solar: 9.2, home: 2.0, battery: 72, ev: 45, exportKW: 0, importKW: 0 },
    cable: true,
    atmo: "",
  },
  v2h: {
    theme: "ev",
    tag: "V2H · Vehicle-to-Home",
    title: "The grid is down. <em>Your car runs the house.</em>",
    body: "During a blackout the EV pushes DC back up the cable into the DC charger at the base of the tower, up to the gateway, and out to every circuit in the home. A 131 kWh truck can run a typical home for 3–5 days.",
    spec: "<strong>~0 ms transfer.</strong> No flicker. Refrigerator keeps running. Medical equipment stays online. A grid-down week becomes a non-event.",
    flows: ["flow-ev-dcc", "flow-bat-gw", "flow-gw-home"],
    stats: { solar: 0, home: 2.4, battery: 12, ev: 68, exportKW: 0, importKW: 0 },
    cable: true,
    atmo: "outage",
  },
  v2g: {
    theme: "v2g",
    tag: "V2G · Vehicle-to-Grid",
    title: "Sell your EV's power at <em>peak rates</em>",
    body: "EV pushes DC up through the cable into the battery tower, then straight out to the utility. Pure outbound: peak-rate revenue on power originally charged cheap. Plug in full at noon, profit by 7 PM.",
    spec: "<strong>Pioneering V2X.</strong> The DC module is designed for V2G; vehicle compatibility rolls out via OTA updates as ISO 15118-20 matures in North America.",
    flows: ["flow-ev-dcc-v2g", "flow-bat-grid-v2g"],
    stats: { solar: 0, home: 2.8, battery: 55, ev: 72, exportKW: 9.5, importKW: 0 },
    cable: true,
    atmo: "",
  },
  "grid-pull": {
    theme: "grid",
    tag: "Grid Pull · Rare With Full Stack",
    title: "When stored energy runs low, <em>the grid fills in</em>",
    body: "On rare cloudy stretches with the batteries drained, the utility quietly backfills — in through the battery tower, up to the gateway, and out to the home. The reverse of the export path.",
    spec: "<strong>Programmable reserve:</strong> keep a user-set % (e.g. 20%) always in the tank for outage readiness. Never caught empty.",
    flows: ["flow-grid-bat", "flow-bat-gw", "flow-gw-home"],
    stats: { solar: 0.2, home: 3.5, battery: 18, ev: 40, exportKW: 0, importKW: 3.3 },
    cable: false,
    atmo: "",
  },
  // Solar only
  "so-day": {
    theme: "solar",
    tag: "Daytime · Solar Only",
    title: "Solar <em>powers the home</em> — but only while the sun shines",
    body: "Panels produce DC, the inverter converts to AC, and your home runs on sun. It works beautifully at noon. The problem is everything that happens outside that window.",
    spec: "<strong>Utilities pay a few ¢/kWh</strong> for excess solar you export — then sell it back that evening at full retail. A large markup on your own power.",
    flows: ["flow-solar-gw", "flow-gw-home", "flow-gw-grid-surplus"],
    stats: { solar: 7.4, home: 2.1, battery: 0, ev: 0, exportKW: 5.3, importKW: 0 },
    cable: false,
    atmo: "",
  },
  "so-night": {
    theme: "grid",
    tag: "Evening · Solar Only",
    title: "Sun goes down. <em>You buy it all back at retail.</em>",
    body: "No sun, no production. Your home pulls from the grid at the full retail rate — including the cheap power you just exported two hours ago. Without a battery there's nothing to fall back on.",
    spec: "<strong>This is the net-metering gap.</strong> Solar-only homes lose much of their excess production value to the utility's rate spread.",
    flows: ["flow-grid-gw-only", "flow-gw-home"],
    stats: { solar: 0, home: 3.2, battery: 0, ev: 0, exportKW: 0, importKW: 3.2 },
    cable: false,
    atmo: "night",
  },
  "so-outage": {
    theme: "grid",
    tag: "Outage · Solar Only",
    title: "The grid goes down. <em>So do your panels.</em>",
    body: "Here's the painful one: when the utility loses power, grid-tied solar inverters are required by code to shut off — even in broad daylight. Without a battery, your panels go dark with everyone else's lights.",
    spec: "<strong>Anti-islanding protection</strong> is a federal requirement (UL 1741). Solar-only homes cannot run during a blackout. Period.",
    flows: [],
    stats: { solar: 0, home: 0, battery: 0, ev: 0, exportKW: 0, importKW: 0 },
    cable: false,
    atmo: "outage",
  },
  // Solar + battery
  "sb-self": {
    theme: "sigenstor",
    tag: "Default · Daytime Operation",
    title: "<em>Self Consumption</em> — use your own sun first",
    body: "Solar DC drops into the gateway, feeds the home, and banks any surplus in the battery. Every watt you produce either powers your home right now or saves itself for tonight.",
    spec: "<strong>Highest-value mode.</strong> You displace retail-rate grid power with panels you already own, and bank the surplus for tonight.",
    flows: ["flow-solar-gw", "flow-gw-home", "flow-gw-bat"],
    stats: { solar: 7.4, home: 2.1, battery: 68, ev: 0, exportKW: 0, importKW: 0 },
    cable: false,
    atmo: "",
  },
  "sb-evening": {
    theme: "sigenstor",
    tag: "Evening Discharge",
    title: "Battery <em>powers the home</em> after sunset",
    body: "The sun is down, the house is awake: dinner, laundry, TV, HVAC. Power comes from the battery at no cost, no utility involvement, no rate spread.",
    spec: "<strong>High continuous discharge</strong> covers central AC + kitchen + lights simultaneously.",
    flows: ["flow-bat-gw", "flow-gw-home"],
    stats: { solar: 0, home: 3.2, battery: 54, ev: 0, exportKW: 0, importKW: 0 },
    cable: false,
    atmo: "night",
  },
  "sb-outage": {
    theme: "ev",
    tag: "Outage · Battery Backup",
    title: "Grid goes down. <em>You don't notice.</em>",
    body: "The battery islands your home almost instantly — fridge, Wi-Fi, lights, medical equipment all keep running. Solar even continues producing during daylight, recharging the battery while the grid is out.",
    spec: "<strong>A multi-module stack</strong> is roughly a full day of essential loads. Add more modules for longer coverage.",
    flows: ["flow-bat-gw", "flow-gw-home"],
    stats: { solar: 0, home: 2.4, battery: 62, ev: 0, exportKW: 0, importKW: 0 },
    cable: false,
    atmo: "outage",
  },
  "sb-grid": {
    theme: "grid",
    tag: "Grid Pull · Rare",
    title: "Battery empty + cloudy day = <em>grid fills in</em>",
    body: "When solar can't keep up and the battery is drained, the utility quietly backfills through the gateway. With a properly sized system, most homes pull from the grid less than 10% of the year.",
    spec: "<strong>Programmable reserve:</strong> hold a user-set % (e.g. 20%) for outage readiness. Never caught empty.",
    flows: ["flow-grid-bat", "flow-bat-gw", "flow-gw-home"],
    stats: { solar: 0.2, home: 3.5, battery: 18, ev: 0, exportKW: 0, importKW: 3.3 },
    cable: false,
    atmo: "",
  },
  // Planning
  "pl-problem": {
    theme: "grid",
    tag: "The Problem",
    title: "Utility rates keep <em>climbing</em>",
    body: "Utilities have raised rates repeatedly over the last decade — and they keep climbing several percent a year. Every year you wait is another year locked into their increases.",
    spec: "<strong>Solar locks your energy cost for 25+ years.</strong> When rates jump next, solar homeowners don't even notice.",
    flows: [],
    stats: { solar: 0, home: 3.2, battery: 0, ev: 0, exportKW: 0, importKW: 3.2 },
    cable: false,
    atmo: "night",
  },
  "pl-solar-only": {
    theme: "solar",
    tag: "Tier 1 · Solar Panels Only",
    title: "<em>The entry tier.</em> Panels, nothing else.",
    body: "8–12 kW on the roof, tied to the grid through a string inverter. Cuts your bill 70–90% on sunny days. But you still pay retail every night, and you still lose power in an outage.",
    spec: "<strong>Lower upfront cost · 8–10 yr payback · No outage protection.</strong>",
    flows: ["flow-solar-gw", "flow-gw-home", "flow-gw-grid-surplus"],
    stats: { solar: 7.4, home: 2.1, battery: 0, ev: 0, exportKW: 5.3, importKW: 0 },
    cable: false,
    atmo: "",
  },
  "pl-solar-batt": {
    theme: "sigenstor",
    tag: "Tier 2 · Solar + Battery",
    title: "The <em>sweet spot</em> for most homes",
    body: "Adds a battery to the solar stack. You use your own production around the clock, you run through outages, and you stop exporting cheap power just to buy it back at retail later. Our most popular tier.",
    spec: "<strong>Mid-range cost · 7–9 yr payback · Full outage protection.</strong>",
    flows: ["flow-solar-gw", "flow-gw-home", "flow-gw-bat"],
    stats: { solar: 7.4, home: 2.1, battery: 68, ev: 0, exportKW: 0, importKW: 0 },
    cable: false,
    atmo: "",
  },
  "pl-full": {
    theme: "ev",
    tag: "Tier 3 · Full Stack",
    title: "Solar + Battery + <em>Bidirectional DC EV Charger</em>",
    body: "The complete stack: every component in one tower, including a DC charger that feeds your EV directly from solar without AC conversion. V2H turns the car into a backup generator. V2G eventually earns peak-rate revenue.",
    spec: "<strong>Full system · 6–8 yr payback · EV fuel savings stack on top.</strong>",
    flows: ["flow-solar-gw", "flow-gw-home", "flow-gw-bat", "flow-dcc-ev"],
    stats: { solar: 9.2, home: 2.0, battery: 72, ev: 45, exportKW: 0, importKW: 0 },
    cable: true,
    atmo: "",
  },
  "pl-ready": {
    theme: "sigenstor",
    tag: "Ready When You Are",
    title: "Every tier is <em>upgrade-ready</em>",
    body: "Not sure where to start? It depends on three questions: how worried are you about outages, do you have (or plan to get) an EV, and what's your budget? Want backup → Tier 2, our best seller. EV on the horizon → skip to Tier 3.",
    spec: "<strong>No pressure.</strong> Free consultation, honest numbers, system sized for your actual usage. Compatible components let you upgrade later without throwaway hardware.",
    flows: [],
    stats: { solar: 0, home: 0, battery: 0, ev: 0, exportKW: 0, importKW: 0 },
    cable: false,
    atmo: "",
  },
};

type SetupKey = "solar-only" | "solar-battery" | "full" | "planning";
const SETUPS: Record<SetupKey, { label: string; ico: string; modes: Array<{ key: string; title: string; sub: string }>; defaultMode: string }> = {
  "solar-only": {
    label: "Solar Only",
    ico: "☀",
    modes: [
      { key: "so-day", title: "Daytime Production", sub: "Solar → Home + Grid export" },
      { key: "so-night", title: "Evening Pull", sub: "Grid at full retail rate" },
      { key: "so-outage", title: "Outage", sub: "Panels forced off" },
    ],
    defaultMode: "so-day",
  },
  "solar-battery": {
    label: "Solar + Battery",
    ico: "☀+▮",
    modes: [
      { key: "sb-self", title: "Self Consumption", sub: "Solar → Home → Battery" },
      { key: "sb-evening", title: "Battery → Home", sub: "Evening discharge" },
      { key: "sb-outage", title: "Outage Backup", sub: "Home runs on battery" },
      { key: "sb-grid", title: "Grid Pull", sub: "Rare fallback" },
    ],
    defaultMode: "sb-self",
  },
  full: {
    label: "+ EV",
    ico: "☀+▮+▣",
    modes: [
      { key: "self", title: "Self Consumption", sub: "Solar → Home → Battery" },
      { key: "battery-home", title: "Battery → Home", sub: "Evening discharge" },
      { key: "ev-charge", title: "DC Charge EV", sub: "Solar/Battery → EV · DC-DC" },
      { key: "v2h", title: "V2H · Outage", sub: "EV powers the home" },
      { key: "v2g", title: "V2G · Sell to Grid", sub: "Peak rate export" },
      { key: "grid-pull", title: "Grid Pull", sub: "Backup from utility" },
    ],
    defaultMode: "self",
  },
  planning: {
    label: "Planning",
    ico: "?",
    modes: [
      { key: "pl-problem", title: "The Rate Problem", sub: "Rising every year" },
      { key: "pl-solar-only", title: "Tier 1 · Panels", sub: "Basic savings" },
      { key: "pl-solar-batt", title: "Tier 2 · + Battery", sub: "Our best seller" },
      { key: "pl-full", title: "Tier 3 · + EV", sub: "Full stack" },
      { key: "pl-ready", title: "Grow At Your Pace", sub: "Start anywhere, upgrade later" },
    ],
    defaultMode: "pl-problem",
  },
};

export interface LivingEnergySceneProps {
  accent?: string;
  batteryName?: string; // selected battery (e.g. "Tesla Powerwall 3")
  monthlyKWh?: number; // customer's real usage → seeds Home Load
  hasEv?: boolean;
  hasExistingSolar?: boolean;
}

export default function LivingEnergyScene({
  accent = "#8b5cf6",
  batteryName,
  monthlyKWh,
  hasEv = false,
  hasExistingSolar = false,
}: LivingEnergySceneProps) {
  const initialSetup: SetupKey = hasEv ? "full" : hasExistingSolar ? "solar-battery" : "full";
  const [setup, setSetup] = useState<SetupKey>(initialSetup);
  const [mode, setMode] = useState<string>(SETUPS[initialSetup].defaultMode);
  // When a hotspot is tapped we show its explainer instead of the mode's, until
  // the mode changes again.
  const [hotspot, setHotspot] = useState<string | null>(null);

  const setupDef = SETUPS[setup];
  const modeDef = MODE_CONTENT[mode] || MODE_CONTENT[setupDef.defaultMode];
  const activeFlows = useMemo(() => new Set(modeDef.flows), [modeDef]);
  const card: InfoCard = hotspot && HOTSPOT_CONTENT[hotspot] ? HOTSPOT_CONTENT[hotspot] : modeDef;

  // Seed Home Load off the customer's real usage when we have it (designed
  // baseline is ~2.1 kW at self-consumption). Scale the per-mode numbers so the
  // demo tracks their actual home rather than a generic figure.
  const homeScale =
    typeof monthlyKWh === "number" && isFinite(monthlyKWh) && monthlyKWh > 0
      ? Math.max(0.45, Math.min(2.6, monthlyKWh / 730 / 2.1)) // monthly→avg kW, ÷ baseline
      : 1;
  const s = modeDef.stats;
  const homeKW = s.home > 0 ? +(s.home * homeScale).toFixed(1) : 0;
  const solarKW = s.solar > 0 ? +(s.solar * (homeScale > 1 ? Math.min(homeScale, 1.8) : 1)).toFixed(1) : 0;

  const batLabel = (batteryName || "Battery").replace(/\s+/g, " ").trim();

  const selectSetup = (k: SetupKey) => {
    setSetup(k);
    setMode(SETUPS[k].defaultMode);
    setHotspot(null);
  };
  const selectMode = (k: string) => {
    setMode(k);
    setHotspot(null);
  };

  const statRows: Array<{ label: string; val: string; color: string }> = [
    { label: "Solar PV", val: `${solarKW.toFixed(1)} kW`, color: "#ffd86b" },
    { label: "Home Load", val: `${homeKW.toFixed(1)} kW`, color: "#ffb84d" },
    { label: `${batLabel} SOC`, val: `${Math.round(s.battery)}%`, color: accent },
    ...(setup === "full" ? [{ label: "EV Battery", val: `${Math.round(s.ev)}%`, color: "#f472b6" }] : []),
    { label: "To Grid", val: s.exportKW > 0.05 ? `${s.exportKW.toFixed(1)} kW` : "— kW", color: "#38bdf8" },
    { label: "From Grid", val: s.importKW > 0.05 ? `${s.importKW.toFixed(1)} kW` : "— kW", color: "#ef4444" },
  ];

  return (
    <div className="les-root" style={{ ["--accent" as string]: accent }}>
      <style>{CSS}</style>

      <div className="les-head">
        <div>
          <div className="les-eyebrow">Live demo · your home as a living energy system</div>
          <h2 className="les-title">See your energy come alive</h2>
        </div>
        <div className="les-setup">
          <div className="les-setup-label">What&rsquo;s your setup?</div>
          <div className="les-setup-tabs">
            {(Object.keys(SETUPS) as SetupKey[]).map((k) => (
              <button
                key={k}
                className={"les-setbtn" + (setup === k ? " on" : "")}
                onClick={() => selectSetup(k)}
              >
                <span className="les-setbtn-ico">{SETUPS[k].ico}</span>
                <span className="les-setbtn-txt">{SETUPS[k].label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="les-grid">
        {/* Scene + mode buttons */}
        <div className="les-scenewrap">
          <div className="les-scene" onClick={(e) => {
            const t = (e.target as HTMLElement).closest("[data-hotspot]") as HTMLElement | null;
            if (t?.dataset.hotspot) setHotspot(t.dataset.hotspot);
          }}>
            <img className="les-img" src={IMG} alt="Your home energy system" draggable={false} />
            <div className={"les-atmo" + (modeDef.atmo ? " " + modeDef.atmo : "")} />
            <div className="les-vignette" />

            <svg className="les-overlay" viewBox="0 0 1600 817" preserveAspectRatio="xMidYMid slice">
              {/* static visible cable, glow when EV connected */}
              <path
                className={"les-cable" + (modeDef.cable ? " on" : "")}
                d={CABLE_D}
                stroke="#8b5cf6"
                strokeWidth={5}
                strokeDasharray="5 9"
                fill="none"
                strokeLinecap="round"
              />
              {/* animated energy flows */}
              {FLOWS.map((f) => (
                <path
                  key={f.id}
                  className={"les-flow" + (f.reverse ? " rev" : "") + (activeFlows.has(f.id) ? " on" : "")}
                  d={f.d}
                  stroke={f.stroke}
                  strokeWidth={f.width}
                  style={{ color: f.stroke }}
                />
              ))}
              {/* hotspots */}
              {HOTSPOTS.map((h) => (
                <g
                  key={h.key}
                  className={"les-hot" + (hotspot === h.key ? " on" : "")}
                  data-hotspot={h.key}
                  transform={`translate(${h.x},${h.y})`}
                >
                  <circle r={36} fill="transparent" style={{ pointerEvents: "auto", cursor: "pointer" }} />
                  <circle className="les-hot-ring" r={14} fill={h.color} opacity={0.35} />
                  <circle r={9} fill={h.color} className="les-hot-dot" />
                  <circle r={3} fill="#fff" />
                  <g className="les-hot-label" transform="translate(0,-30)">
                    <rect x={-46} y={-13} width={92} height={20} rx={10} fill="rgba(10,7,18,0.9)" stroke={h.color} strokeWidth={1} />
                    <text x={0} y={1} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize={9} fill={h.color} fontWeight={700}>
                      {h.key === "sigenstor" ? batLabel.toUpperCase().slice(0, 16) : h.label}
                    </text>
                  </g>
                </g>
              ))}
            </svg>
          </div>

          <div className="les-modes">
            {setupDef.modes.map((m) => (
              <button
                key={m.key}
                className={"les-modebtn" + (mode === m.key && !hotspot ? " on" : "")}
                onClick={() => selectMode(m.key)}
              >
                <span className="les-mode-title">
                  <span className="les-mode-dot" />
                  {m.title}
                </span>
                <span className="les-mode-sub">{m.sub}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Sidebar: status + explainer + legend */}
        <aside className="les-side">
          <div className="les-card">
            <div className="les-card-h">
              <h3>System Status</h3>
              <span className="les-live">Live</span>
            </div>
            {statRows.map((r) => (
              <div className="les-statrow" key={r.label}>
                <div className="les-statlabel">
                  <span className="les-statdot" style={{ background: r.color }} />
                  {r.label}
                </div>
                <div className="les-statval">{r.val}</div>
              </div>
            ))}
          </div>

          <div className={"les-info theme-" + card.theme}>
            <div className="les-info-tag">{card.tag}</div>
            <h2 className="les-info-title" dangerouslySetInnerHTML={{ __html: card.title }} />
            <p className="les-info-body">{stripTags(card.body)}</p>
            <div className="les-info-spec" dangerouslySetInnerHTML={{ __html: card.spec }} />
          </div>

          <div className="les-legend">
            <span><i style={{ background: "#ffd86b" }} />Solar</span>
            <span><i style={{ background: accent }} />Battery</span>
            <span><i style={{ background: "#f472b6" }} />V2H</span>
            <span><i style={{ background: "#fb7185" }} />V2G</span>
            <span><i style={{ background: "#38bdf8" }} />Export</span>
            <span><i style={{ background: "#ef4444" }} />Grid</span>
          </div>
          <div className="les-hint">Tap any glowing spot on the home to learn what it does.</div>
        </aside>
      </div>
    </div>
  );
}

// body text is plain (no inline markup we need) — render as text safely.
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

const CSS = `
.les-root{--solar:#ffd86b;--grid:#ef4444;--export:#38bdf8;--v2h:#f472b6;--v2g:#fb7185;--warm:#ffb84d;
  --line:rgba(255,255,255,0.08);--line2:rgba(255,255,255,0.14);--dim:#8a8199;--accent-bright:#a78bfa;
  --fh:'Space Grotesk',system-ui,-apple-system,sans-serif;
  --fm:'JetBrains Mono','SF Mono',Consolas,monospace;
  --fb:'Inter',system-ui,-apple-system,sans-serif;
  position:relative;z-index:5;width:100%;height:100%;overflow-y:auto;overflow-x:hidden;
  padding:clamp(54px,8vh,72px) clamp(12px,3vw,30px) clamp(40px,7vh,70px);
  color:#ece8f5;font-family:var(--fb);-webkit-overflow-scrolling:touch;}

.les-head{max-width:1320px;margin:0 auto 16px;display:flex;justify-content:space-between;
  align-items:flex-end;gap:16px;flex-wrap:wrap;}
.les-eyebrow{font-family:var(--fm);font-size:10px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--accent-bright);margin-bottom:7px;}
.les-eyebrow::before{content:'·';margin-right:8px;color:var(--accent-bright);}
.les-title{font-family:var(--fh);font-weight:700;font-size:clamp(24px,4vw,42px);line-height:1.02;
  letter-spacing:-.025em;color:#fff;margin:0;}
.les-setup{display:flex;flex-direction:column;align-items:flex-end;gap:7px;}
.les-setup-label{font-family:var(--fm);font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);}
.les-setup-tabs{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;}
.les-setbtn{display:flex;align-items:center;gap:7px;padding:8px 12px;min-width:84px;
  background:rgba(255,255,255,.025);border:1px solid var(--line2);border-radius:10px;color:#ece8f5;
  font-family:var(--fh);font-size:12px;font-weight:600;cursor:pointer;transition:all .2s ease;}
.les-setbtn-ico{font-size:13px;letter-spacing:-.05em;opacity:.75;flex-shrink:0;}
.les-setbtn:hover{border-color:rgba(255,255,255,.25);background:rgba(255,255,255,.05);}
.les-setbtn.on{background:rgba(139,92,246,.16);border-color:var(--accent);box-shadow:0 0 0 3px rgba(139,92,246,.14);}
.les-setbtn.on .les-setbtn-ico{opacity:1;}

.les-grid{max-width:1320px;margin:0 auto;display:grid;grid-template-columns:1fr 360px;gap:18px;align-items:start;}
@media(max-width:1024px){.les-grid{grid-template-columns:1fr;}}

.les-scenewrap{background:#0a0712;border:1px solid var(--line);border-radius:18px;overflow:hidden;}
.les-scene{position:relative;width:100%;aspect-ratio:1600/817;overflow:hidden;background:#0a0712;}
.les-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;user-select:none;}
.les-overlay{position:absolute;inset:0;width:100%;height:100%;display:block;z-index:3;pointer-events:none;}
.les-overlay [data-hotspot]{pointer-events:auto;}
.les-atmo{position:absolute;inset:0;pointer-events:none;z-index:1;opacity:0;transition:opacity 1.1s ease,background 1.1s ease;}
.les-atmo.night{opacity:1;background:radial-gradient(ellipse at 70% 30%,rgba(30,40,80,0) 0%,rgba(8,10,26,0.6) 100%);}
.les-atmo.outage{opacity:1;background:radial-gradient(ellipse at 50% 40%,rgba(80,20,20,0.1) 0%,rgba(12,4,4,0.78) 100%);}
.les-vignette{position:absolute;inset:0;pointer-events:none;z-index:2;
  box-shadow:inset 0 0 120px 30px rgba(0,0,0,0.5);}

.les-flow{fill:none;stroke-dasharray:10 14;stroke-linecap:round;opacity:0;
  transition:opacity .5s ease;filter:drop-shadow(0 0 7px currentColor);
  animation:les-dash 1.6s linear infinite;}
.les-flow.on{opacity:1;}
.les-flow.rev{animation-direction:reverse;}
@keyframes les-dash{to{stroke-dashoffset:-48;}}
.les-cable{opacity:0;transition:opacity .4s;animation:les-dash 1.2s linear infinite;
  filter:drop-shadow(0 0 7px #8b5cf6);}
.les-cable.on{opacity:.95;}

.les-hot-ring{transform-origin:center;transform-box:fill-box;animation:les-pulse 2.5s ease-out infinite;}
@keyframes les-pulse{0%{transform:scale(.6);opacity:.85;}80%{transform:scale(2.4);opacity:0;}100%{opacity:0;}}
.les-hot-dot{filter:drop-shadow(0 0 6px currentColor);}
.les-hot-label{opacity:0;transition:opacity .2s ease;}
.les-hot:hover .les-hot-label,.les-hot.on .les-hot-label{opacity:1;}

.les-modes{display:flex;flex-wrap:wrap;gap:8px;padding:13px;background:rgba(7,5,14,.95);
  border-top:1px solid rgba(255,255,255,.08);}
.les-modebtn{flex:1 1 auto;min-width:128px;padding:10px 12px;background:transparent;
  border:1px solid var(--line2);border-radius:10px;color:#ece8f5;font-family:var(--fb);cursor:pointer;
  transition:all .2s ease;display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-align:left;}
.les-modebtn:hover{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.03);}
.les-modebtn.on{background:rgba(139,92,246,.14);border-color:var(--accent);box-shadow:0 0 0 3px rgba(139,92,246,.16);}
.les-modebtn.on .les-mode-dot{background:var(--accent);box-shadow:0 0 8px var(--accent);}
.les-mode-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:#fff;}
.les-mode-dot{width:6px;height:6px;border-radius:50%;background:var(--dim);transition:all .2s;flex-shrink:0;}
.les-mode-sub{font-family:var(--fm);font-size:9px;color:var(--dim);letter-spacing:.05em;text-transform:uppercase;}

.les-side{display:flex;flex-direction:column;gap:13px;}
.les-card{background:#150f1f;border:1px solid var(--line);border-radius:14px;padding:15px;}
.les-card-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;
  padding-bottom:9px;border-bottom:1px solid var(--line);}
.les-card-h h3{font-family:var(--fm);font-size:10px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--dim);font-weight:500;}
.les-live{display:flex;align-items:center;gap:6px;font-family:var(--fm);font-size:9px;letter-spacing:.15em;
  color:var(--accent);text-transform:uppercase;}
.les-live::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--accent);
  animation:les-blink 1.6s ease-in-out infinite;}
@keyframes les-blink{0%,100%{opacity:1;box-shadow:0 0 6px var(--accent);}50%{opacity:.4;}}
.les-statrow{display:flex;justify-content:space-between;align-items:center;padding:8px 0;
  border-bottom:1px dashed var(--line);font-size:13px;}
.les-statrow:last-child{border-bottom:none;}
.les-statlabel{display:flex;align-items:center;gap:9px;color:#ece8f5;}
.les-statdot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.les-statval{font-family:var(--fm);font-weight:600;font-size:13px;}

.les-info{background:#150f1f;border:1px solid var(--line);border-radius:14px;padding:18px;
  position:relative;overflow:hidden;min-height:200px;}
.les-info::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent);}
.les-info.theme-solar::before{background:var(--solar);}
.les-info.theme-ev::before{background:var(--v2h);}
.les-info.theme-v2g::before{background:var(--v2g);}
.les-info.theme-home::before{background:var(--warm);}
.les-info.theme-grid::before{background:var(--grid);}
.les-info-tag{font-family:var(--fm);font-size:10px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--dim);margin-bottom:8px;}
.les-info-title{font-family:var(--fh);font-weight:600;font-size:21px;line-height:1.15;letter-spacing:-.02em;
  margin:0 0 10px;color:#fff;}
.les-info-title em{font-style:normal;color:var(--accent-bright);font-weight:500;}
.les-info-body{font-size:13px;line-height:1.55;color:#c8c3b3;margin:0 0 10px;}
.les-info-spec{margin-top:10px;padding:10px 12px;background:rgba(139,92,246,.08);
  border-left:2px solid var(--accent);border-radius:0 6px 6px 0;font-size:12px;line-height:1.5;color:#d8d1ea;}
.les-info-spec strong{color:var(--accent-bright);font-family:var(--fm);font-weight:600;}

.les-legend{display:flex;flex-wrap:wrap;gap:8px 14px;padding:11px 13px;background:rgba(255,255,255,.02);
  border:1px solid var(--line);border-radius:12px;font-family:var(--fm);font-size:9px;letter-spacing:.05em;
  text-transform:uppercase;color:var(--dim);}
.les-legend span{display:flex;align-items:center;gap:6px;}
.les-legend i{width:14px;height:2px;border-radius:1px;display:inline-block;}
.les-hint{font-family:var(--fm);font-size:10px;letter-spacing:.04em;color:var(--dim);text-align:center;
  padding:2px 6px;}

@media(prefers-reduced-motion:reduce){
  .les-flow,.les-cable{animation:none!important;}
  .les-flow.on{opacity:1;}.les-cable.on{opacity:.95;}
  .les-hot-ring,.les-live::before{animation:none!important;}
}
`;
