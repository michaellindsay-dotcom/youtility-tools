import { Fragment, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// ────────────────────────────────────────────────────────────────────────────
// Battery Field Playbook — a rep-facing sales aid launched from the Battery Tool
// header. Three tabs: an interactive grid-down DEMO + talk track (Pitch), local
// utility intel (Utility), and two quick door calculators (Numbers).
//
// Themed to match the Battery Tool (deep-violet glass, Space Grotesk / Inter /
// JetBrains Mono). ALL region/locale-specific copy lives in a RegionPlaybook
// object (REGION_PLAYBOOKS below), so adding a new market later is just another
// data entry — the layout is generic. Ships with Charleston / South Carolina.
// ────────────────────────────────────────────────────────────────────────────

// Renders **bold** markers inside otherwise-plain trusted copy.
function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : <Fragment key={i}>{p}</Fragment>))}</>;
}

interface RegionUtility {
  name: string;
  sub: string;
  heat: "warm" | "hot" | "max";
  pay: string;          // "~15¢"
  getLabel: string;     // "Solar Choice export"
  getValue: string;     // "TOU + true-up"
  gap: string;          // supports **bold**
  angle: string;
  hoods: string[];
}
interface RegionPlaybook {
  id: string;
  kitName: string;      // "Charleston Storm Kit"
  seasonChip: string;   // "Storm Season"
  region: string;       // "Lowcountry"
  storms: string;       // "Ian or Dorian"
  opener: string;
  discovery: string[];
  rateAngle: { headline: string; body: string; analogy: string };
  orphanAngle: { headline: string; body: string };
  objections: { q: string; a: string }[];
  honest: string[];
  utilities: RegionUtility[];
  savingsUtilities: { name: string; pay: number; get: number }[];
  stateCredit: string;  // note under the savings readout
  footnote: string;     // e.g. the Duke note
}

const CHARLESTON: RegionPlaybook = {
  id: "charleston",
  kitName: "Charleston Storm Kit",
  seasonChip: "Storm Season",
  region: "Lowcountry",
  storms: "Ian or Dorian",
  opener:
    "“You already made the smart move — you went solar. I'm here about the part the utility keeps quiet: rates are climbing, your buy-back keeps shrinking, and they're reselling your afternoon sun to your neighbors at full retail. Let's make that power **yours to keep**.”",
  discovery: [
    "Since they moved you to **time-of-use**, has your bill actually done what the solar company promised — or has it crept back up?",
    "When Ian or Dorian hit, your panels shut off for safety and you were **just as dark as the house without solar** — how long were you out, and what did it cost you?",
    "Do you even know what your system is producing right now — and **who you'd call** if it stopped tomorrow?",
  ],
  rateAngle: {
    headline: "The rate math they don't advertise",
    body: "Dominion's base rates just went up around **7.6%** — roughly **$12 more a month** on a typical bill — and the fixed monthly charge climbed from $9.50 toward **$13** before you use a single kWh. You're on **time-of-use**, so your midday solar is worth the least and the **6pm peak** costs the most, right as your panels fade. And the surplus you export? They pay you **pennies** and sell it next door at **full retail**.",
    analogy: "Picture the utility as a middleman parked in your driveway: he buys your afternoon sun at wholesale, walks it next door, and sells it to your neighbor at retail — you're his cheapest supplier by day and his full-price customer after dark. **A battery fires the middleman:** you bank your own power and spend it at peak instead of buying it back.",
  },
  orphanAngle: {
    headline: "Who's actually watching your system?",
    body: "A lot of Lowcountry solar was sold by companies that have since **folded, stopped answering the phone, or never really monitored production** in the first place. Panels quietly underproduce for years and nobody catches it. We **monitor it, maintain it, and we're still here** to pick up the phone — so the system you already paid for actually delivers, and the battery on top of it has someone minding it for the long haul.",
  },
  objections: [
    {
      q: "My solar already covers my bill.",
      a: "It did — until time-of-use and this year's rate hike quietly ate into it, and the buy-back rate kept dropping. Pull up a recent **true-up statement** with me. A battery protects the savings you were actually promised and keeps the lights on when the grid drops and your panels shut off with it.",
    },
    {
      q: "My installer handles all that.",
      a: "Are they still in business? A lot of the companies that blanketed the Lowcountry are gone or don't call back. We **monitor and maintain**, we're local, and you get **one number that actually picks up**.",
    },
    {
      q: "I'll just get a generator.",
      a: "A lot of folks do — until the gas stations are dry and it's day three. A battery never asks you to go find fuel in a hurricane, it's silent, and it recharges off the solar you already own. **Show them the demo above.**",
    },
  ],
  honest: [
    "Lead with the **rate reality and resilience** — not a tax credit. The 30% federal credit ended for owned systems in 2026; don't dangle it.",
    "What's still real: SC's **25% state tax credit** (with a qualifying solar-plus-storage project) and a **property-tax exemption**; a lease/PPA can still capture the 48E credit through 2027. Mention it as a bonus — never the headline. The honest headline is simpler: **rates up, buy-back down, and their panels go dark in an outage. The battery fixes all three.**",
  ],
  utilities: [
    {
      name: "Dominion Energy SC",
      sub: "Metro Charleston · former SCE&G",
      heat: "warm",
      pay: "~15¢",
      getLabel: "Solar Choice export",
      getValue: "TOU + true-up",
      gap: "Mandatory **time-of-use** plan, and any extra solar trues up each November at a low avoided-cost rate. Exporting is a bad deal — **self-consumption is the whole game.**",
      angle:
        "“Store your midday solar and spend it at the 6pm peak instead of selling it back cheap. The battery is how you actually keep the savings they promised you.”",
      hoods: ["Mount Pleasant", "West Ashley", "James Island", "North Charleston"],
    },
    {
      name: "Berkeley Electric Co-op",
      sub: "Outlying & coastal areas",
      heat: "hot",
      pay: "~14¢",
      getLabel: "Co-op export",
      getValue: "~4–6¢",
      gap: "Co-ops credit exports at a fraction of retail. **The gap between what they pay and what they get back is huge** — that gap is exactly what a battery recaptures.",
      angle:
        "“On a co-op, sending solar back is almost charity. A battery lets you use every kWh you make instead of giving it away.”",
      hoods: ["Daniel Island", "Goose Creek", "Moncks Corner", "Awendaw"],
    },
    {
      name: "Santee Cooper",
      sub: "State-owned · parts of the Lowcountry",
      heat: "max",
      pay: "~12¢",
      getLabel: "Export credit",
      getValue: "~4¢",
      gap: "Roughly 4¢ summer / 3.8¢ non-summer for exports. **The strongest battery case in the region** — exporting is worth almost nothing here.",
      angle:
        "“Santee Cooper pays you about 4 cents for power worth 12. Store it, don't sell it — that's the entire pitch.”",
      hoods: ["Berkeley pockets", "Georgetown Co.", "Horry Co."],
    },
  ],
  savingsUtilities: [
    { name: "Dominion SC", pay: 15, get: 4 },
    { name: "Berkeley Co-op", pay: 14, get: 5 },
    { name: "Santee Cooper", pay: 12, get: 4 },
  ],
  stateCredit:
    "Then stack SC's **25% state tax credit** (with solar, capped $3,500/yr) and the **property-tax exemption** on top. This estimate is the ongoing recapture only — not the full deal.",
  footnote:
    "Note: **Duke Energy is upstate/Pee Dee, not Charleston.** If you ever work Duke territory, their PowerPair program adds a real battery incentive — but it doesn't apply here.",
};

const REGION_PLAYBOOKS: Record<string, RegionPlaybook> = { charleston: CHARLESTON };

// ── Clean line icons (currentColor stroke, consistent weight) ────────────────
const iconProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const IconFridge = () => (<svg {...iconProps}><rect x="6" y="2.5" width="12" height="19" rx="2.2" /><path d="M6 10h12" /><path d="M9 6v1.5M9 12.5v2.5" /></svg>);
const IconBulb = () => (<svg {...iconProps}><path d="M9 18h6" /><path d="M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1.2 1 1.9v.2h5v-.2c.1-.7.4-1.4 1-1.9A6 6 0 0 0 12 3Z" /></svg>);
const IconWifi = () => (<svg {...iconProps}><path d="M5 12.5a10 10 0 0 1 14 0" /><path d="M8 15.5a5.5 5.5 0 0 1 8 0" /><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" /></svg>);
const IconMedical = () => (<svg {...iconProps}><rect x="3.5" y="6" width="17" height="12" rx="2.4" /><path d="M12 9.5v5M9.5 12h5" /></svg>);
const IconDrop = () => (<svg {...iconProps}><path d="M12 3s6 6.4 6 10.5a6 6 0 0 1-12 0C6 9.4 12 3 12 3Z" /><path d="M9.5 13.5a2.5 2.5 0 0 0 2.5 2.5" /></svg>);
const IconAC = () => (<svg {...iconProps}><rect x="3" y="5" width="18" height="9" rx="2" /><path d="M6.5 9.5h11" /><path d="M8 18c0-1 1-1.5 1-2.5M12 18.5c0-1 1-1.5 1-2.5M16 18c0-1 1-1.5 1-2.5" /></svg>);

type LoadKey = "fridge" | "lights" | "wifi" | "cpap" | "well" | "ac";
const DEMO_LOADS: { key: LoadKey; label: string; essential: boolean; Icon: () => JSX.Element }[] = [
  { key: "fridge", label: "Fridge", essential: true, Icon: IconFridge },
  { key: "lights", label: "Lights", essential: true, Icon: IconBulb },
  { key: "wifi", label: "Wi-Fi", essential: true, Icon: IconWifi },
  { key: "cpap", label: "CPAP", essential: true, Icon: IconMedical },
  { key: "well", label: "Well pump", essential: true, Icon: IconDrop },
  { key: "ac", label: "Central AC", essential: false, Icon: IconAC },
];

const RUN_LOADS: { id: string; label: string; kwh: number; ac?: boolean; on: boolean }[] = [
  { id: "fridge", label: "Fridge / freezer", kwh: 1.5, on: true },
  { id: "lights", label: "Lights + phones", kwh: 1.0, on: true },
  { id: "wifi", label: "Wi-Fi + TV", kwh: 0.6, on: true },
  { id: "cpap", label: "CPAP / medical", kwh: 0.5, on: true },
  { id: "well", label: "Well pump", kwh: 2.0, on: false },
  { id: "window_ac", label: "Window AC", kwh: 5.0, on: false },
  { id: "central_ac", label: "Central AC", kwh: 30, ac: true, on: false },
  { id: "cook", label: "Electric cooking", kwh: 3.0, on: false },
];
const SIZES = [10, 13.5, 20, 27, 40];

const PB_STYLES = `
.bp-root {
  --bp-bg:#0a0712; --bp-900:#0e0a17; --bp-850:#150f1f; --bp-800:#1b1329;
  --bp-line:rgba(255,255,255,0.08); --bp-line-hi:rgba(255,255,255,0.14);
  --bp-accent:#8b5cf6; --bp-accent-hi:#a78bfa; --bp-gold:#ffd86b; --bp-green:#34d399; --bp-red:#f87171;
  --bp-ink:#ece8f5; --bp-dim:#9b93b3; --bp-dim2:#6b6385; --bp-nav:64px;
  position:fixed; inset:0; z-index:7000; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch;
  color:var(--bp-ink); font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  background:
    radial-gradient(120% 60% at 50% -8%, rgba(139,92,246,0.18), transparent 60%),
    radial-gradient(90% 50% at 100% 0%, rgba(167,139,250,0.09), transparent 55%),
    var(--bp-bg);
}
.bp-shell { width:100%; max-width:560px; margin:0 auto; min-height:100%; padding-bottom:calc(var(--bp-nav) + env(safe-area-inset-bottom) + 8px); position:relative; }
.bp-root *, .bp-root *::before, .bp-root *::after { min-width:0; }

.bp-head { position:sticky; top:0; z-index:20; background:linear-gradient(180deg,var(--bp-bg) 70%,rgba(10,7,18,0.85)); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); padding:14px 16px 12px; border-bottom:1px solid var(--bp-line); }
.bp-brandrow { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.bp-brand { display:flex; align-items:center; gap:9px; min-width:0; }
.bp-bolt { width:26px; height:26px; flex:none; }
.bp-word { font-family:'Space Grotesk',sans-serif; font-weight:600; letter-spacing:0.12em; font-size:14px; text-transform:uppercase; line-height:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.bp-word small { display:block; font-family:'JetBrains Mono',monospace; font-size:9.5px; letter-spacing:0.24em; color:var(--bp-accent-hi); font-weight:500; margin-top:3px; }
.bp-season { display:flex; align-items:center; gap:6px; font-size:10.5px; font-weight:600; color:var(--bp-gold); background:rgba(255,216,107,0.10); border:1px solid rgba(255,216,107,0.28); padding:6px 9px; border-radius:20px; text-transform:uppercase; letter-spacing:0.06em; flex:none; }
.bp-pulse { width:7px; height:7px; border-radius:50%; background:var(--bp-gold); animation:bp-pulse 2.4s infinite; }
@keyframes bp-pulse { 0%{box-shadow:0 0 0 0 rgba(255,216,107,0.5)} 70%{box-shadow:0 0 0 7px rgba(255,216,107,0)} 100%{box-shadow:0 0 0 0 rgba(255,216,107,0)} }
.bp-x { position:absolute; top:12px; right:12px; }

.bp-main { padding:18px 16px 8px; }
.bp-eyebrow { font-family:'JetBrains Mono',monospace; font-weight:500; letter-spacing:0.2em; text-transform:uppercase; font-size:11px; color:var(--bp-dim); margin-bottom:8px; }
.bp-h2 { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:23px; line-height:1.05; letter-spacing:-0.01em; margin-bottom:14px; }
.bp-h2 .accent { color:var(--bp-accent-hi); }

.bp-card { background:linear-gradient(180deg,rgba(33,24,48,0.6),rgba(21,15,31,0.6)); border:1px solid var(--bp-line); border-radius:14px; padding:16px; margin-bottom:14px; }
.bp-card h3 { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:15px; letter-spacing:0.01em; color:var(--bp-ink); margin-bottom:10px; display:flex; align-items:center; gap:8px; }
.bp-card h3 .num { font-family:'JetBrains Mono',monospace; font-size:11px; color:#1a1225; background:var(--bp-accent-hi); width:20px; height:20px; border-radius:6px; display:grid; place-items:center; flex:none; font-weight:700; }

/* Grid-down demo */
.bp-demo { background:linear-gradient(180deg,var(--bp-800),var(--bp-900)); border:1px solid var(--bp-line); border-radius:16px; padding:16px 16px 18px; margin-bottom:16px; transition:border-color .3s; }
.bp-demo.down { border-color:rgba(248,113,113,0.4); }
.bp-demo.lit { border-color:rgba(167,139,250,0.5); }
.bp-status { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:13px; letter-spacing:0.06em; text-transform:uppercase; display:flex; align-items:center; gap:8px; margin-bottom:2px; }
.bp-statusline { font-size:12.5px; color:var(--bp-dim); min-height:34px; margin-bottom:14px; }
.bp-dot { width:9px; height:9px; border-radius:50%; flex:none; }
.bp-loads { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; margin-bottom:16px; }
.bp-load { background:var(--bp-bg); border:1px solid var(--bp-line); border-radius:11px; padding:11px 6px 9px; text-align:center; transition:all .35s ease; opacity:0.32; color:var(--bp-dim2); }
.bp-load svg { width:22px; height:22px; margin-bottom:5px; }
.bp-load span { display:block; font-size:10px; font-weight:600; letter-spacing:0.02em; }
.bp-load.on { opacity:1; border-color:rgba(167,139,250,0.45); background:radial-gradient(120% 120% at 50% 0%,rgba(139,92,246,0.18),var(--bp-bg)); color:var(--bp-accent-hi); }
.bp-load.flicker { opacity:0.7; animation:bp-flick 1.3s infinite; color:var(--bp-gold); }
@keyframes bp-flick { 0%,100%{opacity:0.7} 45%{opacity:0.28} 47%{opacity:0.7} 80%{opacity:0.4} }
.bp-toggles { display:flex; gap:9px; }
.bp-tog { flex:1; background:var(--bp-bg); border:1px solid var(--bp-line); border-radius:11px; padding:10px; display:flex; flex-direction:column; gap:7px; cursor:pointer; transition:border-color .2s; }
.bp-tog:active { transform:scale(0.98); }
.bp-toglabel { font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:0.1em; text-transform:uppercase; color:#c8c0dc; font-weight:600; }
.bp-switch { display:flex; align-items:center; gap:8px; font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:14px; letter-spacing:0.03em; text-transform:uppercase; color:#f3f0fb; }
.bp-track { width:38px; height:21px; border-radius:20px; background:var(--bp-line-hi); position:relative; flex:none; transition:background .25s; }
.bp-track::after { content:""; position:absolute; top:2px; left:2px; width:17px; height:17px; border-radius:50%; background:var(--bp-dim); transition:all .25s; }
.bp-tog.on .bp-track { background:var(--bp-accent); }
.bp-tog.on .bp-track::after { left:19px; background:#fff; }
.bp-tog.on { border-color:rgba(139,92,246,0.5); }
.bp-tog.on .bp-switch { color:var(--bp-accent-hi); }
.bp-tog.grid.on .bp-track { background:var(--bp-red); }
.bp-tog.grid.on .bp-switch { color:var(--bp-red); }

.bp-opener { font-family:'Space Grotesk',sans-serif; font-weight:400; font-size:18px; line-height:1.32; color:var(--bp-ink); border-left:3px solid var(--bp-accent); padding-left:13px; }
.bp-opener strong { font-weight:600; color:var(--bp-accent-hi); }
.bp-body { font-size:13.5px; line-height:1.5; color:#d3ddec; }
.bp-body strong { color:var(--bp-accent-hi); font-weight:600; }
.bp-callout { margin-top:12px; background:radial-gradient(130% 100% at 0% 0%,rgba(139,92,246,0.14),var(--bp-850)); border:1px solid rgba(139,92,246,0.3); border-left:3px solid var(--bp-accent); border-radius:12px; padding:12px 14px; font-size:13.5px; line-height:1.5; color:#e3dcf3; }
.bp-callout strong { color:var(--bp-accent-hi); font-weight:600; }
.bp-qlist { list-style:none; display:flex; flex-direction:column; gap:12px; padding:0; margin:0; }
.bp-qlist li { display:flex; gap:11px; font-size:14px; line-height:1.42; color:#cdd8e8; }
.bp-qlist .qn { font-family:'Space Grotesk',sans-serif; font-weight:700; color:var(--bp-accent-hi); flex:none; font-size:15px; }
.bp-qlist strong { color:var(--bp-ink); font-weight:600; }

.bp-vs { display:grid; grid-template-columns:1fr 1fr; border:1px solid var(--bp-line); border-radius:12px; overflow:hidden; }
.bp-vs .col { padding:13px; }
.bp-vs .batt { background:radial-gradient(130% 100% at 0% 0%,rgba(139,92,246,0.12),var(--bp-850)); }
.bp-vs .gen { background:var(--bp-900); border-left:1px solid var(--bp-line); }
.bp-vs .ch { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:13px; letter-spacing:0.04em; text-transform:uppercase; margin-bottom:10px; }
.bp-vs .batt .ch { color:var(--bp-accent-hi); }
.bp-vs .gen .ch { color:var(--bp-dim); }
.bp-vs ul { list-style:none; display:flex; flex-direction:column; gap:8px; padding:0; margin:0; }
.bp-vs li { font-size:12.5px; line-height:1.35; color:#c3d0e2; display:flex; gap:7px; }
.bp-vs li::before { content:""; width:5px; height:5px; border-radius:50%; background:var(--bp-accent-hi); margin-top:6px; flex:none; }
.bp-vs .gen li::before { background:var(--bp-red); }

.bp-obj { border-top:1px solid var(--bp-line); padding-top:12px; margin-top:12px; }
.bp-obj:first-child { border-top:0; padding-top:0; margin-top:0; }
.bp-obj .q { font-size:13px; font-weight:600; color:var(--bp-dim); margin-bottom:5px; }
.bp-obj .a { font-size:13.5px; line-height:1.45; color:#d3ddec; }
.bp-obj .a strong { color:var(--bp-accent-hi); font-weight:600; }

.bp-honest { background:linear-gradient(180deg,rgba(248,113,113,0.08),var(--bp-850)); border:1px solid rgba(248,113,113,0.28); }
.bp-honest h3 { color:var(--bp-red); }
.bp-honest p { font-size:13px; line-height:1.5; color:#d3ddec; margin-bottom:10px; }
.bp-honest p:last-child { margin-bottom:0; }
.bp-honest strong { color:var(--bp-accent-hi); }

/* Utility cards */
.bp-util { width:100%; text-align:left; background:var(--bp-850); border:1px solid var(--bp-line); border-radius:14px; padding:15px 16px; margin-bottom:12px; cursor:pointer; transition:border-color .2s; color:inherit; font-family:inherit; }
.bp-util.open { border-color:var(--bp-line-hi); }
.bp-util .top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.bp-uname { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:16px; }
.bp-uname small { display:block; font-family:'Inter'; font-weight:500; font-size:11px; color:var(--bp-dim); margin-top:2px; }
.bp-heat { font-family:'JetBrains Mono',monospace; font-size:9.5px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; padding:5px 8px; border-radius:20px; flex:none; }
.bp-heat.warm { color:var(--bp-accent-hi); background:rgba(139,92,246,0.14); border:1px solid rgba(139,92,246,0.32); }
.bp-heat.hot { color:var(--bp-gold); background:rgba(255,216,107,0.13); border:1px solid rgba(255,216,107,0.32); }
.bp-heat.max { color:var(--bp-red); background:rgba(248,113,113,0.14); border:1px solid rgba(248,113,113,0.38); }
.bp-rates { display:flex; gap:10px; margin-top:13px; }
.bp-rate { flex:1; background:var(--bp-bg); border:1px solid var(--bp-line); border-radius:10px; padding:10px; }
.bp-rate .rl { font-family:'JetBrains Mono',monospace; font-size:9.5px; letter-spacing:0.06em; text-transform:uppercase; color:var(--bp-dim); margin-bottom:4px; }
.bp-rate .rv { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:18px; font-variant-numeric:tabular-nums; }
.bp-rate.get .rv { color:var(--bp-red); }
.bp-gap { margin-top:11px; background:var(--bp-bg); border:1px dashed var(--bp-line-hi); border-radius:10px; padding:10px 12px; font-size:12.5px; line-height:1.4; color:#cdd8e8; }
.bp-gap strong { color:var(--bp-accent-hi); }
.bp-udetail { max-height:0; overflow:hidden; transition:max-height .3s ease; }
.bp-util.open .bp-udetail { max-height:680px; }
.bp-angle { margin-top:13px; }
.bp-angle .al { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:12px; letter-spacing:0.06em; text-transform:uppercase; color:var(--bp-accent-hi); margin-bottom:7px; }
.bp-angle p { font-size:13px; line-height:1.45; color:#d3ddec; }
.bp-hoods { margin-top:12px; display:flex; flex-wrap:wrap; gap:6px; }
.bp-hood { font-size:11px; color:#bcccdf; background:var(--bp-800); border:1px solid var(--bp-line); border-radius:16px; padding:5px 10px; }
.bp-chev { width:18px; height:18px; transition:transform .3s; flex:none; color:var(--bp-dim); }
.bp-util.open .bp-chev { transform:rotate(180deg); }
.bp-tip { font-size:12px; color:var(--bp-dim); line-height:1.5; padding:2px 2px 10px; }
.bp-tip strong { color:var(--bp-ink); }

/* Calculators */
.bp-seg { display:flex; background:var(--bp-900); border:1px solid var(--bp-line); border-radius:11px; padding:4px; margin-bottom:16px; gap:4px; }
.bp-seg button { flex:1; background:none; border:none; color:var(--bp-dim); font-family:'Space Grotesk',sans-serif; font-weight:500; font-size:12.5px; letter-spacing:0.03em; text-transform:uppercase; padding:9px; border-radius:8px; cursor:pointer; transition:all .2s; }
.bp-seg button.on { background:var(--bp-accent); color:#fff; font-weight:600; }
.bp-field { margin-bottom:15px; }
.bp-flabel { display:block; font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:500; letter-spacing:0.06em; color:var(--bp-dim); text-transform:uppercase; margin-bottom:8px; }
.bp-flabel .v { float:right; font-family:'Space Grotesk',sans-serif; color:var(--bp-accent-hi); font-size:14px; text-transform:none; letter-spacing:0; }
.bp-chips { display:flex; gap:8px; flex-wrap:wrap; }
.bp-chips.loads { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
.bp-chip { background:var(--bp-900); border:1px solid var(--bp-line); border-radius:10px; padding:11px 10px; font-size:13px; font-weight:500; color:#c3d0e2; cursor:pointer; transition:all .18s; display:flex; align-items:center; gap:8px; text-align:left; }
.bp-chip .kwh { margin-left:auto; font-family:'JetBrains Mono',monospace; font-size:10.5px; color:var(--bp-dim); font-variant-numeric:tabular-nums; }
.bp-chip.sel { border-color:var(--bp-accent); background:radial-gradient(130% 120% at 0% 0%,rgba(139,92,246,0.16),var(--bp-900)); color:var(--bp-ink); }
.bp-chip.sel .kwh { color:var(--bp-accent-hi); }
.bp-chip.size { justify-content:center; min-width:56px; flex:1; }
.bp-range { -webkit-appearance:none; appearance:none; width:100%; height:6px; border-radius:6px; background:var(--bp-line-hi); outline:none; margin-top:4px; }
.bp-range::-webkit-slider-thumb { -webkit-appearance:none; width:24px; height:24px; border-radius:50%; background:var(--bp-accent); cursor:pointer; border:3px solid var(--bp-bg); box-shadow:0 0 0 1px var(--bp-accent); }
.bp-range::-moz-range-thumb { width:22px; height:22px; border-radius:50%; background:var(--bp-accent); cursor:pointer; border:3px solid var(--bp-bg); }

.bp-readout { background:linear-gradient(180deg,var(--bp-800),var(--bp-900)); border:1px solid var(--bp-line-hi); border-radius:16px; padding:18px; margin-top:4px; text-align:center; position:relative; overflow:hidden; }
.bp-readout::before { content:""; position:absolute; inset:0; background:radial-gradient(90% 70% at 50% 0%,rgba(139,92,246,0.12),transparent 65%); }
.bp-rl { position:relative; font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:var(--bp-dim); margin-bottom:6px; }
.bp-big { position:relative; font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:46px; line-height:1; color:var(--bp-accent-hi); font-variant-numeric:tabular-nums; }
.bp-big.money { color:var(--bp-gold); }
.bp-big .u { font-size:18px; color:var(--bp-dim); font-weight:500; margin-left:4px; }
.bp-rsub { position:relative; font-size:13px; color:#cdd8e8; margin-top:9px; line-height:1.45; }
.bp-rsub strong { color:var(--bp-accent-hi); }
.bp-big.money + .bp-rsub strong { color:var(--bp-gold); }
.bp-warn { display:flex; align-items:flex-start; gap:8px; background:rgba(248,113,113,0.1); border:1px solid rgba(248,113,113,0.28); border-radius:10px; padding:10px 12px; margin-top:12px; font-size:12px; line-height:1.4; color:#f0c9c5; text-align:left; }
.bp-warn svg { width:16px; height:16px; flex:none; margin-top:1px; color:var(--bp-red); }
.bp-credit { position:relative; margin-top:12px; background:rgba(52,211,153,0.07); border:1px solid rgba(52,211,153,0.25); border-radius:10px; padding:11px 13px; font-size:12.5px; line-height:1.45; color:#cfeee2; text-align:left; }
.bp-credit strong { color:var(--bp-green); }

.bp-foot { padding:14px 4px 6px; }
.bp-disc { font-size:10.5px; color:var(--bp-dim2); line-height:1.5; text-align:center; }

/* Bottom nav */
.bp-nav { position:fixed; bottom:0; left:0; right:0; max-width:560px; margin:0 auto; height:calc(var(--bp-nav) + env(safe-area-inset-bottom)); padding-bottom:env(safe-area-inset-bottom); background:rgba(12,9,22,0.92); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); border-top:1px solid var(--bp-line); display:flex; z-index:30; }
.bp-nav button { flex:1; background:none; border:none; color:var(--bp-dim); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; cursor:pointer; padding-top:6px; font-family:'Space Grotesk',sans-serif; font-weight:500; font-size:11px; letter-spacing:0.06em; text-transform:uppercase; transition:color .2s; }
.bp-nav button svg { width:22px; height:22px; }
.bp-nav button.on { color:var(--bp-accent-hi); }

@media (prefers-reduced-motion:reduce) { .bp-root *, .bp-root *::before, .bp-root *::after { transition:none !important; animation:none !important; } }
`;

type Tab = "pitch" | "utility" | "numbers";

export default function BatteryPlaybook({ companyName, region = "charleston", overrides, onClose }: {
  companyName?: string;
  region?: string;
  // Company-level overrides saved from the admin console (Battery Playbook).
  // Deep-merged over the regional default so admins can keep rate figures and
  // utility export rates current without a code deploy.
  overrides?: Record<string, unknown> | null;
  onClose: () => void;
}) {
  const base = REGION_PLAYBOOKS[region] || CHARLESTON;
  // Shallow top-level merge is enough: each override key (rateAngle, utilities,
  // savingsUtilities, …) is saved whole by the admin editor, and only non-empty
  // keys are written — so an unset field keeps the built-in default.
  const pb: RegionPlaybook = { ...base, ...(overrides || {}) } as RegionPlaybook;
  const [tab, setTab] = useState<Tab>("pitch");

  // Grid-down demo
  const [gridDown, setGridDown] = useState(false);
  const [batt, setBatt] = useState(false);

  // Utility accordion
  const [openUtil, setOpenUtil] = useState<number | null>(null);

  // Calculators
  const [calc, setCalc] = useState<"run" | "save">("run");
  const [size, setSize] = useState(13.5);
  const [runSel, setRunSel] = useState<Record<string, boolean>>(
    Object.fromEntries(RUN_LOADS.map((l) => [l.id, l.on]))
  );
  const [savePick, setSavePick] = useState(0);
  const [exportKwh, setExportKwh] = useState(250);

  const demoState = useMemo(() => {
    if (!gridDown) return { dot: "var(--bp-gold)", title: "Grid online — power's flowing", line: "Everything runs off the grid, like normal.", loads: "on" as const };
    if (!batt) return { dot: "var(--bp-red)", title: "Grid down — no battery", line: "You're in the dark. Fridge warming, phones dying, well pump off.", loads: "off" as const };
    return { dot: "var(--bp-accent-hi)", title: "Grid down — battery carrying the home", line: "Essentials stay lit for days. AC flickers — it draws too much to run all day.", loads: "batt" as const };
  }, [gridDown, batt]);

  const run = useMemo(() => {
    let draw = 0, acOn = false;
    for (const l of RUN_LOADS) if (runSel[l.id]) { draw += l.kwh; if (l.ac) acOn = true; }
    if (draw <= 0) return { draw: 0, acOn, val: "—", unit: "", sub: "Pick what needs to stay on." };
    const days = size / draw;
    const val = days >= 1 ? days.toFixed(1) : String(Math.round(days * 24));
    const unit = days >= 1 ? "days" : (Math.round(days * 24) === 1 ? "hour" : "hours");
    return { draw, acOn, val, unit, sub: `Pulling **${draw.toFixed(1)} kWh/day** off a **${size} kWh** battery. Solar recharge extends this every sunny hour.` };
  }, [runSel, size]);

  const save = useMemo(() => {
    const u = pb.savingsUtilities[savePick] || pb.savingsUtilities[0];
    const gap = u.pay - u.get;
    const yr = Math.round((exportKwh * gap) / 100 * 12);
    return { yr, sub: `They pay **${u.pay}¢** but get **${u.get}¢** back. That **${gap}¢ gap** on ${exportKwh} kWh/mo is money a battery keeps in the house.` };
  }, [pb.savingsUtilities, savePick, exportKwh]);

  return createPortal(
    <div className="bp-root" role="dialog" aria-modal="true" aria-label={`${pb.kitName} field playbook`}>
      <style>{PB_STYLES}</style>
      <div className="bp-shell">
        <header className="bp-head">
          <div className="bp-brandrow">
            <div className="bp-brand">
              <svg className="bp-bolt" viewBox="0 0 24 24" fill="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" fill="#a78bfa" stroke="#a78bfa" strokeWidth="1.4" strokeLinejoin="round" /></svg>
              <div className="bp-word">{companyName || "Field Playbook"}<small>{pb.kitName}</small></div>
            </div>
            <div className="bp-season"><span className="bp-pulse" />{pb.seasonChip}</div>
          </div>
          <button className="btn ghost sm bp-x" onClick={onClose} aria-label="Close playbook">✕</button>
        </header>

        <main className="bp-main">
          {tab === "pitch" && (
            <section>
              <div className="bp-eyebrow">The demo · show them, don't tell them</div>
              <div className={"bp-demo" + (demoState.loads === "off" ? " down" : demoState.loads === "batt" ? " lit" : "")}>
                <div className="bp-status"><span className="bp-dot" style={{ background: demoState.dot }} />{demoState.title}</div>
                <div className="bp-statusline">{demoState.line}</div>
                <div className="bp-loads">
                  {DEMO_LOADS.map(({ key, label, essential, Icon }) => {
                    const cls = demoState.loads === "on" ? "on"
                      : demoState.loads === "off" ? ""
                      : essential ? "on" : "flicker";
                    return (
                      <div key={key} className={"bp-load" + (cls ? " " + cls : "")}>
                        <Icon /><span>{label}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="bp-toggles">
                  <button className={"bp-tog grid" + (gridDown ? " on" : "")} onClick={() => setGridDown((v) => !v)}>
                    <span className="bp-toglabel">Grid</span>
                    <span className="bp-switch"><span className="bp-track" />{gridDown ? "Down" : "Online"}</span>
                  </button>
                  <button className={"bp-tog" + (batt ? " on" : "")} onClick={() => setBatt((v) => !v)}>
                    <span className="bp-toglabel">Their battery</span>
                    <span className="bp-switch"><span className="bp-track" />{batt ? "On" : "Off"}</span>
                  </button>
                </div>
              </div>

              <div className="bp-card"><div className="bp-opener"><Rich text={pb.opener} /></div></div>

              <div className="bp-card">
                <h3><span className="num">?</span>Discovery — let them talk</h3>
                <ul className="bp-qlist">
                  {pb.discovery.map((q, i) => (
                    <li key={i}><span className="qn">{i + 1}</span><span><Rich text={q} /></span></li>
                  ))}
                </ul>
              </div>

              <div className="bp-card">
                <h3><span className="num">$</span>{pb.rateAngle.headline}</h3>
                <p className="bp-body"><Rich text={pb.rateAngle.body} /></p>
                <div className="bp-callout"><Rich text={pb.rateAngle.analogy} /></div>
              </div>

              <div className="bp-card">
                <h3><span className="num">◎</span>{pb.orphanAngle.headline}</h3>
                <p className="bp-body"><Rich text={pb.orphanAngle.body} /></p>
              </div>

              <div className="bp-card">
                <h3>Battery vs. the generator next door</h3>
                <div className="bp-vs">
                  <div className="col batt">
                    <div className="ch">Home battery</div>
                    <ul>
                      <li>Silent — no engine, no neighbors complaining</li>
                      <li>No fuel runs during a storm</li>
                      <li>Switches over automatically, instantly</li>
                      <li>Recharges from your own solar for days</li>
                      <li>Safe indoors — zero fumes</li>
                    </ul>
                  </div>
                  <div className="col gen">
                    <div className="ch">Gas generator</div>
                    <ul>
                      <li>Needs fuel you can't get mid-disaster</li>
                      <li>Loud, fumes, manual start</li>
                      <li>Refuel every few hours, day and night</li>
                      <li>Dies when the gas runs out</li>
                      <li>Carbon monoxide risk</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="bp-card">
                <h3>Handle the pushback</h3>
                {pb.objections.map((o, i) => (
                  <div key={i} className="bp-obj">
                    <div className="q">&ldquo;{o.q}&rdquo;</div>
                    <div className="a"><Rich text={o.a} /></div>
                  </div>
                ))}
              </div>

              <div className="bp-card bp-honest">
                <h3>Stay honest — it closes</h3>
                {pb.honest.map((p, i) => <p key={i}><Rich text={p} /></p>)}
              </div>
            </section>
          )}

          {tab === "utility" && (
            <section>
              <div className="bp-eyebrow">Know the territory first</div>
              <h2 className="bp-h2">Which meter is on <span className="accent">their wall?</span></h2>
              <p className="bp-tip">The economics flip block to block. Confirm the utility before you run numbers — a weaker export rate makes your battery case <strong>stronger</strong>, not weaker.</p>
              {pb.utilities.map((u, i) => (
                <button key={i} className={"bp-util" + (openUtil === i ? " open" : "")} onClick={() => setOpenUtil((cur) => (cur === i ? null : i))}>
                  <div className="top">
                    <div className="bp-uname">{u.name}<small>{u.sub}</small></div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={"bp-heat " + u.heat}>{u.heat}</span>
                      <svg className="bp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
                    </div>
                  </div>
                  <div className="bp-rates">
                    <div className="bp-rate pay"><div className="rl">They pay</div><div className="rv">{u.pay}</div></div>
                    <div className="bp-rate get"><div className="rl">{u.getLabel}</div><div className="rv">{u.getValue}</div></div>
                  </div>
                  <div className="bp-udetail">
                    <div className="bp-gap"><Rich text={u.gap} /></div>
                    <div className="bp-angle"><div className="al">Your angle</div><p>{u.angle}</p></div>
                    <div className="bp-hoods">{u.hoods.map((h) => <span key={h} className="bp-hood">{h}</span>)}</div>
                  </div>
                </button>
              ))}
              <p className="bp-tip" style={{ marginTop: 4 }}><Rich text={pb.footnote} /></p>
            </section>
          )}

          {tab === "numbers" && (
            <section>
              <div className="bp-eyebrow">Run it at the door</div>
              <h2 className="bp-h2">The <span className="accent">numbers</span> that matter</h2>
              <div className="bp-seg">
                <button className={calc === "run" ? "on" : ""} onClick={() => setCalc("run")}>Storm runtime</button>
                <button className={calc === "save" ? "on" : ""} onClick={() => setCalc("save")}>Solar you're giving away</button>
              </div>

              {calc === "run" && (
                <>
                  <div className="bp-card">
                    <div className="bp-field">
                      <label className="bp-flabel">Battery size <span className="v">{size} kWh</span></label>
                      <div className="bp-chips">
                        {SIZES.map((s) => (
                          <button key={s} className={"bp-chip size" + (size === s ? " sel" : "")} onClick={() => setSize(s)}>{s}</button>
                        ))}
                      </div>
                      <p className="bp-tip" style={{ padding: "8px 0 0" }}>SigenStor stacks modularly — start small, add more.</p>
                    </div>
                    <div className="bp-field" style={{ marginBottom: 6 }}>
                      <label className="bp-flabel">What are we keeping on?</label>
                      <div className="bp-chips loads">
                        {RUN_LOADS.map((l) => (
                          <button key={l.id} className={"bp-chip" + (runSel[l.id] ? " sel" : "")} onClick={() => setRunSel((c) => ({ ...c, [l.id]: !c[l.id] }))}>
                            {l.label}<span className="kwh">{l.kwh}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="bp-readout">
                    <div className="bp-rl">Backup runtime, no sun</div>
                    <div className="bp-big">{run.val}<span className="u">{run.unit}</span></div>
                    <div className="bp-rsub"><Rich text={run.sub} /></div>
                    {run.acOn && (
                      <div className="bp-warn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
                        <span>Central AC drains any home battery fast. Be honest: back up essentials for days, or cool one room with a window unit — not the whole house for a week.</span>
                      </div>
                    )}
                  </div>
                </>
              )}

              {calc === "save" && (
                <>
                  <div className="bp-card">
                    <div className="bp-field">
                      <label className="bp-flabel">Their utility</label>
                      <div className="bp-chips">
                        {pb.savingsUtilities.map((u, i) => (
                          <button key={u.name} className={"bp-chip" + (savePick === i ? " sel" : "")} onClick={() => setSavePick(i)}>{u.name}</button>
                        ))}
                      </div>
                    </div>
                    <div className="bp-field">
                      <label className="bp-flabel">Solar sent back to grid each month <span className="v">{exportKwh} kWh</span></label>
                      <input className="bp-range" type="range" min={0} max={900} step={10} value={exportKwh} onChange={(e) => setExportKwh(Number(e.target.value))} />
                      <p className="bp-tip" style={{ padding: "8px 0 0" }}>Pull this from their bill or solar app — the "exported" or "sold" number.</p>
                    </div>
                  </div>
                  <div className="bp-readout">
                    <div className="bp-rl">Value the battery recaptures / year</div>
                    <div className="bp-big money">${save.yr.toLocaleString()}</div>
                    <div className="bp-rsub"><Rich text={save.sub} /></div>
                    <div className="bp-credit"><Rich text={pb.stateCredit} /></div>
                  </div>
                </>
              )}
            </section>
          )}

          <footer className="bp-foot">
            <p className="bp-disc">Field estimates for conversation, not a binding quote. Confirm the homeowner's actual tariff and system before proposing. Not tax or financial advice — homeowners should confirm credits with a tax professional.</p>
          </footer>
        </main>

        <nav className="bp-nav">
          <button className={tab === "pitch" ? "on" : ""} onClick={() => setTab("pitch")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 10h8M8 14h5" /><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z" /></svg>Pitch
          </button>
          <button className={tab === "utility" ? "on" : ""} onClick={() => setTab("utility")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21V9l9-6 9 6v12" /><path d="M9 21v-6h6v6" /></svg>Utility
          </button>
          <button className={tab === "numbers" ? "on" : ""} onClick={() => setTab("numbers")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h5" /></svg>Numbers
          </button>
        </nav>
      </div>
    </div>,
    document.body
  );
}
