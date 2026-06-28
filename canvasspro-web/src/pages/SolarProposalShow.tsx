import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// SolarProposalShow — a full-screen, client-side, presenter-driven slide deck a
// closer plays for a homeowner at the kitchen table. Pure React + inline SVG +
// an injected <style> block — no external animation libraries. The centerpiece
// is an interactive home scene whose energy flows morph between four scenarios.
//
// VISUAL LANGUAGE: futuristic deep-purple "Youtility" aesthetic — glassmorphism
// cards with hairline borders + energy-colored accent bars, mono HUD readouts,
// neon marching-ants energy flows, and a grain + glow atmosphere. Mirrors (and
// extends) the sigenstor_home reference. All classes prefixed `sps-`.
// ─────────────────────────────────────────────────────────────────────────────

// A single battery the rep can select / compare inside the interactive proposal.
// Built in BatteryTool from the offered recommendations + marketing content.
export interface ProposalOption {
  productId: string;
  brand: string;
  model: string;
  units: number;
  totalUsableKWh: number;
  totalContinuousKW: number;
  totalPeakKW: number;
  backupDaysAchieved: number;
  warrantyYears: number;
  chemistry: string;
  tagline: string;
  features: string[];
  benefits: string[];
  accent: string;
  roi: {
    grossCost: number;
    incentives: number;
    netCost: number;
    monthlySavings: number;
    lifetimeSavings: number;
  };
  recommended: boolean;
}

export interface SolarShowProps {
  open: boolean;
  onClose: () => void;
  customerName?: string;
  address?: string;
  companyName?: string;
  // numbers (all optional — render graceful fallbacks/placeholders when missing)
  monthlyBill?: number; // current bill $/mo (no solar)
  monthlyKWh?: number;
  recommendation?: {
    brand: string;
    model: string;
    units: number;
    totalUsableKWh: number;
    backupDaysAchieved: number;
  } | null;
  roi?: {
    grossCost: number;
    incentives: number;
    netCost: number;
    monthlySavings: number;
    lifetimeSavings: number;
  } | null;
  incentives?: Array<{
    name: string;
    amount?: string;
    administrator?: string;
    startDate?: string | null;
    endDate?: string | null;
    url?: string;
  }>;
  hasEv?: boolean; // EV charger selected
  hasExistingSolar?: boolean;
  videoUrls?: Partial<Record<"nosolar" | "solar" | "battery" | "ev", string>>;
  // Real photo of the customer's home (a data URI). Preferred hero imagery —
  // rendered full-bleed on the cover + as the night backdrop on the backup slide.
  homeImage?: string;
  homeImageIsStreetView?: boolean; // true → Street View, false → Satellite
  // Interactive CRM proposal: the full set of offered batteries the rep can pick
  // and compare. When present, the recommendation/savings/backup slides re-theme
  // to the selected battery and extra slides (3D/AR, features, compare) appear.
  // When absent/empty the show behaves exactly as before.
  options?: ProposalOption[];
  chosenProductId?: string; // the battery currently selected in the tool
}

type Scenario = "nosolar" | "solar" | "battery" | "ev";

// Energy palette — matches the reference design tokens.
const PALETTE = {
  solar: "#ffd86b",
  battery: "#8b5cf6",
  grid: "#ef4444",
  export: "#38bdf8",
  ev: "#f472b6",
  accent: "#8b5cf6",
  accentBright: "#a78bfa",
  text: "#ece8f5",
  textDim: "#8a8199",
};

const money0 = (n: number | undefined | null) =>
  typeof n === "number" && isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—";

// Parse a #rrggbb / #rgb hex string into [r,g,b,1] floats 0–1 for the 3D model's
// base-color factor. Falls back to the brand purple on anything unparseable.
function hexToRgb01(hex: string): [number, number, number, number] {
  let h = (hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [0.545, 0.361, 0.965, 1]; // #8b5cf6
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b, 1];
}

// model-viewer is a custom element loaded from a CDN — declare it so TSX/JSX
// accepts the tag and its attributes without pulling in an npm dependency.
type ModelViewerElement = HTMLElement & {
  model?: {
    materials?: Array<{
      pbrMetallicRoughness?: { setBaseColorFactor?: (rgba: [number, number, number, number]) => void };
    }>;
  };
  activateAR?: () => void;
};
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          alt?: string;
          ar?: boolean;
          "ar-modes"?: string;
          "camera-controls"?: boolean;
          "auto-rotate"?: boolean;
          "shadow-intensity"?: string;
          exposure?: string;
          "touch-action"?: string;
        },
        HTMLElement
      >;
    }
  }
}

// ── count-up hook (rAF easing) ───────────────────────────────────────────────
function useCountUp(target: number | undefined | null, active: boolean, durationMs = 1100) {
  const [val, setVal] = useState(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active || typeof target !== "number" || !isFinite(target)) {
      setVal(typeof target === "number" && isFinite(target) ? target : 0);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setVal(target);
      return;
    }
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(from + (target - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, active, durationMs]);
  return val;
}

// ── HUD live stat chips overlaid on the scene ────────────────────────────────
function SceneHud({
  scenario,
  night,
  hasEv,
  monthlyKWh,
}: {
  scenario: Scenario;
  night: boolean;
  hasEv: boolean;
  monthlyKWh?: number;
}) {
  // Derive tasteful "live" numbers. Home draw scales loosely off monthly usage;
  // otherwise fall back to pleasant static defaults.
  const homeKW =
    typeof monthlyKWh === "number" && isFinite(monthlyKWh) && monthlyKWh > 0
      ? Math.max(0.8, Math.min(6, monthlyKWh / 730)) // kWh/mo → avg kW, clamped
      : 2.4;

  const batteryActive = scenario === "battery" || scenario === "ev";
  const isNight = batteryActive && night;

  type Chip = { label: string; value: string; color: string };
  const chips: Chip[] = [];

  if (scenario === "nosolar") {
    chips.push({ label: "GRID", value: `${homeKW.toFixed(1)} kW`, color: PALETTE.grid });
    chips.push({ label: "HOME", value: `${homeKW.toFixed(1)} kW`, color: PALETTE.accentBright });
  } else if (isNight) {
    chips.push({ label: "SOLAR", value: "0.0 kW", color: PALETTE.solar });
    chips.push({ label: "BATTERY", value: "87%", color: PALETTE.battery });
    chips.push({ label: "GRID", value: "OFFLINE", color: PALETTE.grid });
    chips.push({ label: "HOME", value: `${homeKW.toFixed(1)} kW`, color: PALETTE.accentBright });
  } else {
    const solarKW = (homeKW + (batteryActive ? 1.8 : 0) + (scenario === "ev" ? 3.2 : 0.9)).toFixed(1);
    chips.push({ label: "SOLAR", value: `${solarKW} kW`, color: PALETTE.solar });
    if (batteryActive)
      chips.push({ label: "BATTERY", value: scenario === "ev" ? "64%" : "72%", color: PALETTE.battery });
    if (scenario === "solar")
      chips.push({ label: "EXPORT", value: "1.4 kW", color: PALETTE.export });
    if (scenario === "ev" && hasEv)
      chips.push({ label: "EV", value: "3.2 kW", color: PALETTE.ev });
    chips.push({ label: "HOME", value: `${homeKW.toFixed(1)} kW`, color: PALETTE.accentBright });
  }

  return (
    <div className="sps-hud" key={scenario + String(night)}>
      {chips.map((c) => (
        <div className="sps-chip" key={c.label}>
          <span className="sps-chip-dot" style={{ background: c.color, boxShadow: `0 0 8px ${c.color}` }} />
          <span className="sps-chip-label">{c.label}</span>
          <span className="sps-chip-sep">▸</span>
          <span className="sps-chip-val" style={{ color: c.color }}>{c.value}</span>
        </div>
      ))}
      <div className="sps-chip sps-chip-live">
        <span className="sps-live-dot" />
        <span className="sps-chip-label">LIVE</span>
      </div>
    </div>
  );
}

// ── The interactive home SVG ─────────────────────────────────────────────────
function HomeScene({
  scenario,
  night,
  hasEv,
}: {
  scenario: Scenario;
  night: boolean;
  hasEv: boolean;
}) {
  // Which flows are active for each scenario.
  const solarActive = scenario === "solar" || scenario === "battery" || scenario === "ev";
  const batteryActive = scenario === "battery" || scenario === "ev";
  const evActive = scenario === "ev";
  // In battery/ev night mode the grid goes dark (outage) and the battery powers the home.
  const isNight = (scenario === "battery" || scenario === "ev") && night;
  const gridDark = isNight;
  const sunUp = solarActive && !isNight;

  // Flow visibility:
  const gridFlow = scenario === "nosolar"; // red, grid → home
  const solarToHome = solarActive && !isNight;
  const solarToGrid = scenario === "solar" && !isNight; // export (blue)
  const solarToBattery = batteryActive && !isNight; // charging (purple)
  const batteryToHome = batteryActive && isNight; // discharging at night (purple)
  const toEv = evActive && (isNight ? batteryToHome : solarActive); // car charging (pink)

  return (
    <svg
      className={"sps-scene" + (isNight ? " night" : "") + (gridDark ? " outage" : "")}
      viewBox="0 0 400 260"
      role="img"
      aria-label="Home energy scene"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="sps-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={isNight ? "#0a0a1f" : "#241640"} />
          <stop offset="1" stopColor={isNight ? "#080612" : "#160e2a"} />
        </linearGradient>
        <linearGradient id="sps-roof" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a2240" />
          <stop offset="1" stopColor="#1a1430" />
        </linearGradient>
        <linearGradient id="sps-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={isNight ? "#171127" : "#221a36"} />
          <stop offset="1" stopColor={isNight ? "#100b1c" : "#181126"} />
        </linearGradient>
        <radialGradient id="sps-sunglow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={isNight ? "#cdd6f4" : "#ffe9a8"} stopOpacity="0.9" />
          <stop offset="1" stopColor={isNight ? "#9aa6d4" : "#ffd86b"} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sps-panel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b2a66" />
          <stop offset="1" stopColor="#1a1233" />
        </linearGradient>
        <linearGradient id="sps-batgrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#6d28d9" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
        <radialGradient id="sps-ground" cx="0.5" cy="0" r="1">
          <stop offset="0" stopColor={isNight ? "#0e0a1c" : "#140e26"} />
          <stop offset="1" stopColor="#080510" />
        </radialGradient>
      </defs>

      {/* sky */}
      <rect x="0" y="0" width="400" height="210" fill="url(#sps-sky)" />

      {/* stars at night */}
      {isNight &&
        [
          [30, 30],
          [70, 18],
          [120, 40],
          [340, 26],
          [300, 48],
          [250, 22],
          [380, 60],
          [20, 70],
          [180, 24],
        ].map(([cx, cy], i) => (
          <circle
            key={i}
            className="sps-star"
            cx={cx}
            cy={cy}
            r={1.4}
            fill="#cbd5f5"
            style={{ animationDelay: `${i * 0.3}s` }}
          />
        ))}

      {/* sun / moon */}
      <g
        className={"sps-sun" + (sunUp ? " on" : "")}
        style={{ transformOrigin: "330px 48px" }}
      >
        <circle cx="330" cy="48" r="46" fill="url(#sps-sunglow)" />
        <circle
          cx="330"
          cy="48"
          r="18"
          fill={isNight ? "#cdd6f4" : "#ffe9a8"}
          stroke={isNight ? "#9aa6d4" : "#ffd86b"}
          strokeWidth="2"
        />
        {!isNight &&
          Array.from({ length: 8 }).map((_, i) => {
            const a = (i / 8) * Math.PI * 2;
            const x1 = 330 + Math.cos(a) * 24;
            const y1 = 48 + Math.sin(a) * 24;
            const x2 = 330 + Math.cos(a) * 32;
            const y2 = 48 + Math.sin(a) * 32;
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#ffd86b"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            );
          })}
      </g>

      {/* ground */}
      <rect x="0" y="206" width="400" height="54" fill="url(#sps-ground)" />
      <line x1="0" y1="206" x2="400" y2="206" stroke="rgba(167,139,250,0.18)" strokeWidth="1" />

      {/* ── Grid: pole + power lines (left) ── */}
      <g className={"sps-grid" + (gridDark ? " dark" : "")}>
        <line x1="28" y1="120" x2="28" y2="206" stroke="#4a4060" strokeWidth="4" strokeLinecap="round" />
        <line x1="14" y1="128" x2="42" y2="128" stroke="#4a4060" strokeWidth="3" strokeLinecap="round" />
        <line x1="14" y1="138" x2="42" y2="138" stroke="#4a4060" strokeWidth="3" strokeLinecap="round" />
        {/* slack wire toward the house */}
        <path d="M28 130 Q70 150 110 150" fill="none" stroke="#352d4a" strokeWidth="2" />
        <text x="28" y="200" textAnchor="middle" className="sps-svglabel">GRID</text>
        {gridDark && (
          <text x="28" y="112" textAnchor="middle" className="sps-outage" fill={PALETTE.grid}>
            ⚠ OUTAGE
          </text>
        )}
      </g>

      {/* ── House ── */}
      <g>
        {/* glow base under house */}
        <ellipse cx="210" cy="208" rx="92" ry="10" fill={PALETTE.accent} opacity={isNight ? 0.1 : 0.16} />
        {/* body */}
        <rect x="150" y="130" width="120" height="76" rx="4" fill="url(#sps-wall)" stroke="rgba(167,139,250,0.14)" strokeWidth="1" />
        {/* roof */}
        <polygon points="140,133 210,94 280,133" fill="url(#sps-roof)" stroke="rgba(167,139,250,0.12)" strokeWidth="1" />
        {/* door */}
        <rect x="200" y="168" width="20" height="38" rx="2" fill={isNight ? "#0c0818" : "#140e24"} />
        <circle cx="216" cy="188" r="1.4" fill={PALETTE.accentBright} />
        {/* windows — glow when powered */}
        {[
          [164, 150],
          [236, 150],
          [164, 178],
        ].map(([x, y], i) => (
          <rect
            key={i}
            x={x}
            y={y}
            width="20"
            height="18"
            rx="2"
            className="sps-window lit"
            style={{ animationDelay: `${i * 0.2}s` }}
          />
        ))}

        {/* roof solar panels */}
        <g className={"sps-panels" + (solarActive && !isNight ? " active" : "")}>
          {[0, 1, 2, 3].map((i) => (
            <g key={i} transform={`translate(${168 + i * 18}, 112)`}>
              <polygon
                points={`0,8 14,4 14,16 0,20`}
                fill="url(#sps-panel)"
                stroke="#0e0820"
                strokeWidth="0.6"
              />
            </g>
          ))}
          {/* shine sweep when active */}
          {solarActive && !isNight && (
            <polygon className="sps-shine" points="168,118 240,98 240,104 168,124" fill="#d6c4ff" />
          )}
        </g>
      </g>

      {/* ── Wall battery (right of house) ── */}
      <g className={"sps-battery" + (batteryActive ? " active" : "")}>
        <rect
          x="288"
          y="148"
          width="28"
          height="50"
          rx="6"
          fill="#140d24"
          stroke={batteryActive ? PALETTE.battery : "#352d4a"}
          strokeWidth="1.5"
        />
        <clipPath id="sps-batclip">
          <rect x="290" y="150" width="24" height="46" rx="4" />
        </clipPath>
        <g clipPath="url(#sps-batclip)">
          <rect
            className={
              "sps-batfill" +
              (batteryActive && !isNight ? " filling" : "") +
              (batteryActive && isNight ? " full" : "")
            }
            x="290"
            y="150"
            width="24"
            height="46"
            fill="url(#sps-batgrad)"
          />
        </g>
        {/* terminal */}
        <rect x="298" y="145" width="8" height="4" rx="1.5" fill={batteryActive ? PALETTE.battery : "#352d4a"} />
        <text x="302" y="208" textAnchor="middle" className="sps-svglabel" fill={batteryActive ? PALETTE.accentBright : PALETTE.textDim}>
          BATTERY
        </text>
      </g>

      {/* ── EV in driveway ── */}
      {hasEv && (
        <g className={"sps-ev" + (evActive ? " active" : "")} transform="translate(92, 176)">
          {/* car body — sleek silhouette */}
          <rect x="0" y="12" width="48" height="14" rx="7" fill={evActive ? "#2a1f44" : "#171127"} stroke={evActive ? PALETTE.ev : "#352d4a"} strokeWidth="1.2" />
          <path d="M9 12 Q15 1 26 1 L34 1 Q41 3 43 12 Z" fill={evActive ? "#3a2a55" : "#1a1330"} stroke={evActive ? PALETTE.ev : "transparent"} strokeWidth="0.8" />
          <circle cx="13" cy="27" r="5" fill="#0a0616" stroke="#5b4d75" strokeWidth="1.5" />
          <circle cx="37" cy="27" r="5" fill="#0a0616" stroke="#5b4d75" strokeWidth="1.5" />
          {/* charge bar above the car */}
          <rect x="7" y="-9" width="34" height="5" rx="2.5" fill="#0a0616" stroke="#352d4a" strokeWidth="0.8" />
          <rect className={"sps-evcharge" + (evActive ? " on" : "")} x="8" y="-8" width="32" height="3" rx="1.5" fill={PALETTE.ev} />
        </g>
      )}

      {/* ════ ENERGY FLOW PATHS (neon marching ants) ════ */}
      {/* grid → home (red) */}
      <path
        className={"sps-flow grid" + (gridFlow ? " on" : "")}
        d="M44 150 Q100 150 150 160"
      />
      {/* solar(panels) → home (gold) */}
      <path
        className={"sps-flow solar" + (solarToHome ? " on" : "")}
        d="M205 110 L205 150"
      />
      {/* solar → grid export (blue, flowing left) */}
      <path
        className={"sps-flow export rev" + (solarToGrid ? " on" : "")}
        d="M150 140 Q100 140 44 138"
      />
      {/* solar → battery (purple) */}
      <path
        className={"sps-flow battery" + (solarToBattery ? " on" : "")}
        d="M250 120 Q295 120 302 150"
      />
      {/* battery → home (purple, flowing left into house) */}
      <path
        className={"sps-flow battery rev" + (batteryToHome ? " on" : "")}
        d="M288 172 L270 172"
      />
      {/* power → EV (pink) */}
      {hasEv && (
        <path
          className={"sps-flow ev rev" + (toEv ? " on" : "")}
          d="M150 190 Q128 190 140 190"
        />
      )}
    </svg>
  );
}

export default function SolarProposalShow(props: SolarShowProps) {
  const {
    open,
    onClose,
    customerName,
    address,
    companyName,
    monthlyBill,
    monthlyKWh,
    recommendation,
    roi,
    incentives,
    hasEv = false,
    hasExistingSolar = false,
    videoUrls,
    homeImage,
    homeImageIsStreetView = false,
    options,
    chosenProductId,
  } = props;

  const hasOptions = !!(options && options.length);

  const [idx, setIdx] = useState(0);
  // The interactive home scenario + day/night.
  const [scenario, setScenario] = useState<Scenario>("nosolar");
  const [night, setNight] = useState(false);

  // CRM proposal: which battery is selected (drives specs/savings/3D/features) and
  // which two are being compared (max 2). Defaults to the chosen/top option.
  const [selectedId, setSelectedId] = useState<string>(
    chosenProductId || options?.[0]?.productId || ""
  );
  const [compareIds, setCompareIds] = useState<string[]>(
    options ? options.slice(0, 2).map((o) => o.productId) : []
  );

  const active = useMemo(
    () => options?.find((o) => o.productId === selectedId) || options?.[0],
    [options, selectedId]
  );

  // Effective recommendation / ROI the slides render: the selected battery's data
  // when options are provided, else the single legacy props (nothing breaks).
  const effRec = useMemo(
    () =>
      active
        ? {
            brand: active.brand,
            model: active.model,
            units: active.units,
            totalUsableKWh: active.totalUsableKWh,
            backupDaysAchieved: active.backupDaysAchieved,
          }
        : recommendation,
    [active, recommendation]
  );
  const effRoi = useMemo(() => (active ? active.roi : roi), [active, roi]);
  // The accent that re-themes the whole proposal to the selected battery.
  const brandAccent = active?.accent || PALETTE.accent;

  const reduceMotion = useRef(false);
  useEffect(() => {
    reduceMotion.current =
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // model-viewer load state: "idle" (not requested), "loading", "ready" (custom
  // element defined) or "failed" (didn't define in time → CSS/SVG fallback).
  const [mvState, setMvState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const mvRef = useRef<ModelViewerElement | null>(null);

  // Build the slide list — hide the savings slide if there's no roi data.
  const slides = useMemo(() => {
    const list: Array<{ key: string }> = [
      { key: "cover" },
      { key: "interactive" },
    ];
    // CRM proposal slides — only when an option set is provided.
    if (hasOptions) {
      list.push({ key: "battery3d" });
      list.push({ key: "whybattery" });
    }
    if (effRoi) list.push({ key: "savings" });
    if (effRec) list.push({ key: "backup" });
    if (hasOptions && (options?.length ?? 0) >= 2) list.push({ key: "compare" });
    if (incentives && incentives.length) list.push({ key: "incentives" });
    list.push({ key: "cta" });
    return list;
  }, [hasOptions, options, effRoi, effRec, incentives]);

  const count = slides.length;
  const clamp = useCallback((n: number) => Math.max(0, Math.min(count - 1, n)), [count]);
  const next = useCallback(() => setIdx((i) => clamp(i + 1)), [clamp]);
  const prev = useCallback(() => setIdx((i) => clamp(i - 1)), [clamp]);

  // Reset to the first slide each time the show opens.
  useEffect(() => {
    if (open) {
      setIdx(0);
      setScenario(hasExistingSolar ? "solar" : "nosolar");
      setNight(false);
      // Re-seed the battery selection from the current props on (re)open.
      if (options && options.length) {
        setSelectedId(chosenProductId || options[0].productId);
        setCompareIds(options.slice(0, 2).map((o) => o.productId));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasExistingSolar]);

  // Keyboard nav + Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, prev, onClose]);

  // Touch swipe.
  const touchX = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? 0) - touchX.current;
    if (Math.abs(dx) > 50) {
      if (dx < 0) next();
      else prev();
    }
    touchX.current = null;
  };

  // count-ups become active when the savings slide is the current one.
  const activeKey = slides[idx]?.key;
  const netUp = useCountUp(effRoi?.netCost, open && activeKey === "savings");
  const moUp = useCountUp(effRoi?.monthlySavings, open && activeKey === "savings", 900);
  const lifeUp = useCountUp(effRoi?.lifetimeSavings, open && activeKey === "savings", 1400);

  // Lazy-load Google's <model-viewer> web component the first time the 3D slide is
  // shown. Inject the module script once (guard against double-inject across mounts
  // via a window flag), then poll customElements until it defines — or fall back to
  // the CSS/SVG battery after a few seconds on a slow/blocked connection.
  useEffect(() => {
    if (!open || activeKey !== "battery3d") return;
    if (typeof window === "undefined") return;
    if (window.customElements?.get?.("model-viewer")) {
      setMvState("ready");
      return;
    }
    setMvState((s) => (s === "ready" || s === "failed" ? s : "loading"));
    const w = window as unknown as { __spsMvInjected?: boolean };
    if (!w.__spsMvInjected) {
      w.__spsMvInjected = true;
      const el = document.createElement("script");
      el.type = "module";
      el.src = "https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js";
      el.onerror = () => setMvState((s) => (s === "ready" ? s : "failed"));
      document.head.appendChild(el);
    }
    let tries = 0;
    const poll = window.setInterval(() => {
      tries++;
      if (window.customElements?.get?.("model-viewer")) {
        setMvState("ready");
        window.clearInterval(poll);
      } else if (tries > 25) {
        // ~5s at 200ms — give up and show the graceful fallback.
        setMvState((s) => (s === "ready" ? s : "failed"));
        window.clearInterval(poll);
      }
    }, 200);
    return () => window.clearInterval(poll);
  }, [open, activeKey]);

  // Recolor the loaded model to the selected battery's brand accent. Runs when the
  // model-viewer is ready and whenever the selection changes; also re-applies on
  // the element's `load` event (the model may finish loading after mount).
  useEffect(() => {
    if (mvState !== "ready" || activeKey !== "battery3d") return;
    const el = mvRef.current;
    if (!el) return;
    const accent = active?.accent || PALETTE.accent;
    const apply = () => {
      try {
        const mat = el.model?.materials?.[0];
        mat?.pbrMetallicRoughness?.setBaseColorFactor?.(hexToRgb01(accent));
      } catch {
        /* model not ready yet — the load event will retry */
      }
    };
    apply();
    el.addEventListener("load", apply);
    return () => el.removeEventListener("load", apply);
  }, [mvState, activeKey, active?.accent, selectedId]);

  if (!open) return null;

  const name = customerName?.trim() || "Your Home";
  const company = companyName?.trim() || "";

  const scenarioCaption: Record<Scenario, string> = {
    nosolar:
      typeof monthlyBill === "number"
        ? `Today you draw 100% from the grid — about ${money0(monthlyBill)}/mo, rising every year.`
        : `Today you draw 100% of your power from the grid — and the bill rises every year.`,
    solar:
      `Your panels offset daytime usage and export the extra back to the grid, lowering your bill.`,
    battery: night
      ? `When the grid goes down, your battery keeps the lights on${
          recommendation ? ` for ~${recommendation.backupDaysAchieved} days` : ""
        }.`
      : `By day, sunshine fills your battery${
          recommendation ? ` — ${recommendation.units}× ${recommendation.model}` : ""
        } while powering the home.`,
    ev: `Charge your car on sunshine — drive on energy you made, not energy you bought.`,
  };

  const scenarioOptions: Array<{ key: Scenario; label: string; sub: string; icon: string }> = [
    { key: "nosolar", label: "No solar", sub: "GRID ONLY", icon: "⚡" },
    { key: "solar", label: "Solar", sub: "DAYTIME OFFSET", icon: "☀" },
    { key: "battery", label: "Solar + Battery", sub: "STORE & BACKUP", icon: "▮" },
    { key: "ev", label: "+ EV charger", sub: "DRIVE ON SUN", icon: "⊳" },
  ];

  const videoForScenario = videoUrls?.[scenario];

  // Themed accent bar color for the interactive slide.
  const sceneTheme =
    scenario === "nosolar"
      ? "grid"
      : scenario === "solar"
      ? "solar"
      : scenario === "ev"
      ? "ev"
      : "battery";

  return (
    <div className="sps-root" role="dialog" aria-modal="true" aria-label="Interactive solar proposal">
      <style>{CSS}</style>

      {/* atmosphere overlays */}
      <div className="sps-grain" aria-hidden="true" />
      <div className="sps-vignette" aria-hidden="true" />

      <button className="sps-close" onClick={onClose} aria-label="Close presentation">
        ✕
      </button>

      {/* Slide viewport */}
      <div
        className="sps-stage"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="sps-track" style={{ transform: `translateX(-${idx * 100}%)` }}>
          {slides.map((s) => (
            <section className="sps-slide" key={s.key} aria-hidden={slides[idx]?.key !== s.key}>
              {s.key === "cover" && (
                <CoverSlide
                  name={name}
                  address={address}
                  company={company}
                  active={activeKey === "cover"}
                  hasEv={hasEv}
                  homeImage={homeImage}
                  homeImageIsStreetView={homeImageIsStreetView}
                />
              )}

              {s.key === "interactive" && (
                <div className={"sps-inner sps-rise" + (activeKey === "interactive" ? " in" : "")}>
                  <div className="sps-eyebrow">Live demo</div>
                  <h2 className="sps-h2">See your energy come alive</h2>

                  <div className="sps-switcher">
                    {scenarioOptions.map((o) => (
                      <button
                        key={o.key}
                        className={"sps-scbtn" + (scenario === o.key ? " on" : "")}
                        onClick={() => {
                          setScenario(o.key);
                          if (o.key !== "battery" && o.key !== "ev") setNight(false);
                        }}
                      >
                        <span className="sps-scbtn-ico">{o.icon}</span>
                        <span className="sps-scbtn-txt">
                          <span className="sps-scbtn-label">{o.label}</span>
                          <span className="sps-scbtn-sub">{o.sub}</span>
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className={"sps-sceneWrap sps-theme-" + sceneTheme}>
                    {videoForScenario ? (
                      <video
                        className="sps-video"
                        src={videoForScenario}
                        autoPlay
                        muted
                        loop
                        playsInline
                      />
                    ) : (
                      <>
                        <HomeScene scenario={scenario} night={night} hasEv={hasEv} />
                        <SceneHud scenario={scenario} night={night} hasEv={hasEv} monthlyKWh={monthlyKWh} />
                        {homeImage && (
                          <div className="sps-homeInset">
                            <img src={homeImage} alt="Your home" />
                            <span className="sps-homeInset-label">YOUR HOME</span>
                          </div>
                        )}
                      </>
                    )}

                    {(scenario === "battery" || scenario === "ev") && (
                      <div className="sps-daynight">
                        <button
                          className={"sps-dnbtn" + (!night ? " on" : "")}
                          onClick={() => setNight(false)}
                        >
                          ☀ Day
                        </button>
                        <button
                          className={"sps-dnbtn" + (night ? " on" : "")}
                          onClick={() => setNight(true)}
                        >
                          ☾ Night
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="sps-legend">
                    <span><i style={{ background: PALETTE.grid }} /> Grid</span>
                    <span><i style={{ background: PALETTE.solar }} /> Solar</span>
                    <span><i style={{ background: PALETTE.battery }} /> Battery</span>
                    <span><i style={{ background: PALETTE.export }} /> Export</span>
                    {hasEv && <span><i style={{ background: PALETTE.ev }} /> EV</span>}
                  </div>

                  <p className="sps-caption" key={scenario + String(night)}>
                    {scenarioCaption[scenario]}
                  </p>
                </div>
              )}

              {s.key === "battery3d" && active && (
                <div className={"sps-inner sps-rise" + (activeKey === "battery3d" ? " in" : "")}>
                  <div className="sps-eyebrow">Your battery</div>
                  <h2 className="sps-h2">Meet your {active.brand} {active.model}</h2>

                  <BatterySelector
                    options={options || []}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />

                  <div className="sps-3dwrap" style={{ ["--accent" as string]: brandAccent }}>
                    {mvState === "failed" ? (
                      <BatteryFallback accent={brandAccent} label={`${active.brand} ${active.model}`} />
                    ) : (
                      <model-viewer
                        ref={mvRef as unknown as React.Ref<HTMLElement>}
                        src="/app/battery.glb"
                        alt={`${active.brand} ${active.model} 3D model`}
                        camera-controls
                        auto-rotate
                        ar
                        ar-modes="webxr scene-viewer quick-look"
                        shadow-intensity="1"
                        exposure="1"
                        touch-action="pan-y"
                        style={{ width: "100%", height: "100%", background: "transparent", ["--poster-color" as string]: "transparent" }}
                      />
                    )}

                    {/* HTML overlay: model name + key specs + AR launch */}
                    <div className="sps-3dover">
                      <div className="sps-3dname">
                        {active.units}× {active.brand} {active.model}
                      </div>
                      <div className="sps-3dspecs">
                        <span><b>{active.totalUsableKWh}</b> kWh usable</span>
                        <span><b>{active.totalContinuousKW}</b> kW cont.</span>
                        <span><b>{active.backupDaysAchieved}</b> day backup</span>
                      </div>
                    </div>
                    {mvState === "failed" && (
                      <div className="sps-3dnote">3D viewer unavailable on this connection.</div>
                    )}
                    {mvState !== "failed" && (
                      <button
                        className="sps-arbtn"
                        style={{ borderColor: brandAccent }}
                        onClick={() => {
                          try { mvRef.current?.activateAR?.(); } catch { /* AR unsupported */ }
                        }}
                      >
                        📱 View in your space (AR)
                      </button>
                    )}
                  </div>
                  <p className="sps-caption">
                    Spin it, zoom in, or place it on your wall in AR — this is the unit we'd install.
                  </p>
                </div>
              )}

              {s.key === "whybattery" && active && (
                <div className={"sps-inner sps-rise" + (activeKey === "whybattery" ? " in" : "")}>
                  <div className="sps-eyebrow">Why this battery</div>
                  <h2 className="sps-h2">{active.brand} {active.model}</h2>

                  <BatterySelector
                    options={options || []}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />

                  <div className="sps-crm" style={{ ["--accent" as string]: brandAccent }}>
                    <div className="sps-crm-col sps-crm-feat">
                      <div className="sps-crm-tagline">{active.tagline}</div>
                      <div className="sps-crm-h">Features</div>
                      <ul className="sps-crm-list">
                        {active.features.map((f, i) => (
                          <li key={i}><span className="sps-crm-check" style={{ color: brandAccent }}>✦</span>{f}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="sps-crm-col sps-crm-ben">
                      <div className="sps-crm-h">What it means for you</div>
                      <ul className="sps-crm-list">
                        {active.benefits.map((b, i) => (
                          <li key={i}><span className="sps-crm-dot" style={{ background: brandAccent, boxShadow: `0 0 8px ${brandAccent}` }} />{b}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {s.key === "compare" && options && options.length >= 2 && (
                <div className={"sps-inner sps-rise" + (activeKey === "compare" ? " in" : "")}>
                  <div className="sps-eyebrow">Side by side</div>
                  <h2 className="sps-h2">Compare two batteries</h2>
                  <CompareSlide
                    options={options}
                    compareIds={compareIds}
                    setCompareIds={setCompareIds}
                  />
                </div>
              )}

              {s.key === "savings" && effRoi && (
                <div className={"sps-inner sps-rise" + (activeKey === "savings" ? " in" : "")}>
                  <div className="sps-eyebrow">The numbers</div>
                  <h2 className="sps-h2">Your savings</h2>
                  {hasOptions && active && (
                    <div className="sps-activePill" style={{ borderColor: brandAccent }}>
                      <span className="sps-activePill-dot" style={{ background: brandAccent, boxShadow: `0 0 8px ${brandAccent}` }} />
                      {active.units}× {active.brand} {active.model}
                    </div>
                  )}
                  <div
                    className="sps-bignum"
                    style={{ ["--accent" as string]: brandAccent, ["--accent-bright" as string]: brandAccent, ["--battery" as string]: brandAccent }}
                  >
                    <div className="sps-bignum-label">Net cost after incentives</div>
                    <div className="sps-bignum-value">{money0(netUp)}</div>
                    <div className="sps-bignum-eq">
                      {money0(effRoi.grossCost)} gross − {money0(effRoi.incentives)} incentives ={" "}
                      <strong>{money0(effRoi.netCost)}</strong>
                    </div>
                  </div>
                  <div className="sps-savegrid">
                    <div className="sps-savecard sps-theme-solar">
                      <div className="sps-saveval">
                        <span className="sps-save-dot" style={{ background: PALETTE.solar }} />
                        {money0(moUp)}
                      </div>
                      <div className="sps-savelabel">Estimated monthly savings</div>
                    </div>
                    <div className="sps-savecard sps-theme-export">
                      <div className="sps-saveval">
                        <span className="sps-save-dot" style={{ background: PALETTE.export }} />
                        {money0(lifeUp)}
                      </div>
                      <div className="sps-savelabel">Lifetime savings</div>
                    </div>
                  </div>
                </div>
              )}

              {s.key === "backup" && effRec && (
                <div className={"sps-inner sps-rise" + (activeKey === "backup" ? " in" : "")}>
                  <div className="sps-eyebrow">Resilience</div>
                  <h2 className="sps-h2">Peace of mind, day and night</h2>
                  <div className="sps-backupGrid">
                    {homeImage ? (
                      <div className="sps-miniScene sps-nightHome">
                        <img className="sps-nightHome-img" src={homeImage} alt="Your home at night" />
                        <div className="sps-nightHome-scrim" aria-hidden="true" />
                        <div className="sps-nightHome-glow" aria-hidden="true" />
                        <span className="sps-nightHome-label">
                          YOUR HOME · LIGHTS ON
                        </span>
                      </div>
                    ) : (
                      <div className="sps-miniScene">
                        <HomeScene scenario="battery" night hasEv={false} />
                      </div>
                    )}
                    <div
                      className="sps-syscard"
                      style={{ ["--battery" as string]: brandAccent, ["--accent-bright" as string]: brandAccent }}
                    >
                      <div className="sps-tag">System recommendation</div>
                      <div className="sps-sysname">
                        {effRec.units}× {effRec.brand} {effRec.model}
                      </div>
                      <div className="sps-sysstats">
                        <div>
                          <div className="sps-sysn">{effRec.totalUsableKWh}</div>
                          <div className="sps-sysl">kWh usable</div>
                        </div>
                        <div>
                          <div className="sps-sysn">{effRec.backupDaysAchieved}</div>
                          <div className="sps-sysl">days backup</div>
                        </div>
                        <div>
                          <div className="sps-sysn">{effRec.units}</div>
                          <div className="sps-sysl">units</div>
                        </div>
                      </div>
                      <p className="sps-syslead">
                        When the grid goes dark, your lights stay on. No spoiled food, no cold
                        showers, no scrambling for a generator.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {s.key === "incentives" && incentives && incentives.length > 0 && (
                <div className={"sps-inner sps-rise" + (activeKey === "incentives" ? " in" : "")}>
                  <div className="sps-eyebrow">Money back</div>
                  <h2 className="sps-h2">Your incentives</h2>
                  <p className="sps-sub">Verified from official sources.</p>
                  <div className="sps-inclist">
                    {incentives.map((inc, i) => (
                      <div className="sps-inccard sps-theme-solar" key={i} style={{ animationDelay: `${0.06 * i}s` }}>
                        <div className="sps-incName">{inc.name}</div>
                        {inc.amount && <span className="sps-incAmt">{inc.amount}</span>}
                        <div className="sps-incMeta">
                          {[
                            inc.administrator,
                            [inc.startDate, inc.endDate].filter(Boolean).join(" – ") || null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        {inc.url && (
                          <a className="sps-incLink" href={inc.url} target="_blank" rel="noreferrer">
                            Verify source ↗
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {s.key === "cta" && (
                <div className={"sps-inner sps-cta sps-rise" + (activeKey === "cta" ? " in" : "")}>
                  <div className="sps-ctaGlow" />
                  <div className="sps-eyebrow">Next step</div>
                  <h2 className="sps-ctaTitle">Let&rsquo;s do this, {name.split(" ")[0]}.</h2>
                  <p className="sps-ctaSub">
                    Lower bills, real backup, and energy on your terms — starting now.
                  </p>
                  {monthlyBill != null && effRoi?.monthlySavings != null && (
                    <p className="sps-ctaLine">
                      From {money0(monthlyBill)}/mo on the grid to about{" "}
                      {money0(effRoi.monthlySavings)}/mo back in your pocket.
                    </p>
                  )}
                  {company && <div className="sps-ctaCompany">{company}</div>}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>

      {/* Controls */}
      <button
        className="sps-nav prev"
        onClick={prev}
        disabled={idx === 0}
        aria-label="Previous slide"
      >
        ‹
      </button>
      <button
        className="sps-nav next"
        onClick={next}
        disabled={idx === count - 1}
        aria-label="Next slide"
      >
        ›
      </button>

      <div className="sps-dots">
        {slides.map((s, i) => (
          <button
            key={s.key}
            className={"sps-dot" + (i === idx ? " on" : "")}
            onClick={() => setIdx(i)}
            aria-label={`Go to slide ${i + 1}`}
          />
        ))}
      </div>
    </div>
  );
}

// ── Cover slide (animated hero) ──────────────────────────────────────────────
function CoverSlide({
  name,
  address,
  company,
  active,
  hasEv,
  homeImage,
  homeImageIsStreetView,
}: {
  name: string;
  address?: string;
  company: string;
  active: boolean;
  hasEv: boolean;
  homeImage?: string;
  homeImageIsStreetView?: boolean;
}) {
  // When we have a real photo of the home, use it as a full-bleed background
  // hero behind a navy scrim. Otherwise fall back to the animated SVG cover.
  if (homeImage) {
    return (
      <div className={"sps-inner sps-cover sps-coverPhoto" + (active ? " in" : "")}>
        <div className="sps-coverPhoto-bg" aria-hidden="true">
          <div
            className="sps-coverPhoto-img"
            style={{ backgroundImage: `url(${homeImage})` }}
          />
          <div className="sps-coverPhoto-scrim" />
        </div>
        <div className="sps-coverText sps-coverText-photo">
          <div className="sps-coverTag">
            YOUR HOME · {homeImageIsStreetView ? "STREET VIEW" : "SATELLITE"}
          </div>
          <div className="sps-eyebrow">{company || "A proposal prepared for you"}</div>
          <h1 className="sps-title">Your Energy Future</h1>
          <div className="sps-coverName">{name}</div>
          {address && <div className="sps-coverAddr">{address}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={"sps-inner sps-cover" + (active ? " in" : "")}>
      <div className="sps-coverHero">
        <HomeScene scenario="solar" night={false} hasEv={hasEv} />
      </div>
      <div className="sps-coverText">
        <div className="sps-eyebrow">{company || "A proposal prepared for you"}</div>
        <h1 className="sps-title">Your Energy Future</h1>
        <div className="sps-coverName">{name}</div>
        {address && <div className="sps-coverAddr">{address}</div>}
      </div>
    </div>
  );
}

// ── Battery selector (persistent across CRM slides) ──────────────────────────
function BatterySelector({
  options,
  selectedId,
  onSelect,
}: {
  options: ProposalOption[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (!options.length) return null;
  return (
    <div className="sps-batsel" role="tablist" aria-label="Choose your battery">
      {options.map((o) => {
        const on = o.productId === selectedId;
        return (
          <button
            key={o.productId}
            role="tab"
            aria-selected={on}
            className={"sps-batsel-item" + (on ? " on" : "")}
            style={on ? { borderColor: o.accent, boxShadow: `0 0 0 2px ${o.accent}55` } : undefined}
            onClick={() => onSelect(o.productId)}
          >
            <span className="sps-batsel-swatch" style={{ background: o.accent }} />
            <span className="sps-batsel-txt">
              <span className="sps-batsel-name">{o.brand} {o.model}</span>
              <span className="sps-batsel-kwh">{o.totalUsableKWh} kWh{o.units > 1 ? ` · ${o.units} units` : ""}</span>
            </span>
            {o.recommended && <span className="sps-batsel-badge">★ Recommended</span>}
          </button>
        );
      })}
    </div>
  );
}

// ── CSS/SVG fallback battery (when model-viewer can't load) ──────────────────
function BatteryFallback({ accent, label }: { accent: string; label: string }) {
  return (
    <div className="sps-batfb" aria-label={`${label} (stylized)`}>
      <svg viewBox="0 0 120 220" className="sps-batfb-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="sps-fbbody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={accent} stopOpacity="0.5" />
            <stop offset="1" stopColor={accent} stopOpacity="0.14" />
          </linearGradient>
        </defs>
        {/* terminal */}
        <rect x="46" y="6" width="28" height="10" rx="3" fill={accent} />
        {/* body */}
        <rect x="20" y="16" width="80" height="196" rx="18" fill="url(#sps-fbbody)" stroke={accent} strokeWidth="2" />
        {/* glowing charge bar */}
        <rect x="34" y="150" width="52" height="46" rx="8" fill={accent} opacity="0.9" className="sps-batfb-charge" />
        <rect x="34" y="40" width="52" height="100" rx="8" fill={accent} opacity="0.12" />
        {/* bolt */}
        <path d="M64 60 L48 104 L60 104 L54 144 L74 96 L62 96 Z" fill="#fff" opacity="0.9" />
      </svg>
      <div className="sps-batfb-label">{label}</div>
    </div>
  );
}

// ── Compare two batteries ────────────────────────────────────────────────────
function CompareSlide({
  options,
  compareIds,
  setCompareIds,
}: {
  options: ProposalOption[];
  compareIds: string[];
  setCompareIds: (ids: string[]) => void;
}) {
  const aId = compareIds[0] || options[0]?.productId;
  const bId = compareIds[1] || options[1]?.productId;
  const a = options.find((o) => o.productId === aId) || options[0];
  const b = options.find((o) => o.productId === bId) || options[1];

  const pick = (slot: 0 | 1, id: string) => {
    const next: string[] = [compareIds[0] ?? aId, compareIds[1] ?? bId];
    next[slot] = id;
    setCompareIds(next);
  };

  if (!a || !b) return null;

  // higher = better for most rows; netCost lower is better.
  type Row = { label: string; av: number; bv: number; fmt: (n: number) => string; lowerBetter?: boolean };
  const rows: Row[] = [
    { label: "Usable kWh", av: a.totalUsableKWh, bv: b.totalUsableKWh, fmt: (n) => `${n} kWh` },
    { label: "Continuous kW", av: a.totalContinuousKW, bv: b.totalContinuousKW, fmt: (n) => `${n} kW` },
    { label: "Surge kW", av: a.totalPeakKW, bv: b.totalPeakKW, fmt: (n) => `${n} kW` },
    { label: "Backup days", av: a.backupDaysAchieved, bv: b.backupDaysAchieved, fmt: (n) => `${n}` },
    { label: "Warranty", av: a.warrantyYears, bv: b.warrantyYears, fmt: (n) => `${n} yr` },
    { label: "Net cost", av: a.roi.netCost, bv: b.roi.netCost, fmt: (n) => money0(n), lowerBetter: true },
    { label: "Est. monthly savings", av: a.roi.monthlySavings, bv: b.roi.monthlySavings, fmt: (n) => `${money0(n)}/mo` },
  ];

  const Picker = ({ slot, val, side }: { slot: 0 | 1; val: string; side: "a" | "b" }) => (
    <select
      className="sps-cmp-pick"
      value={val}
      style={{ borderColor: side === "a" ? a.accent : b.accent }}
      onChange={(e) => pick(slot, e.target.value)}
    >
      {options.map((o) => (
        <option key={o.productId} value={o.productId}>
          {o.brand} {o.model}
        </option>
      ))}
    </select>
  );

  return (
    <div className="sps-cmp" style={{ ["--a-accent" as string]: a.accent, ["--b-accent" as string]: b.accent }}>
      <div className="sps-cmp-heads">
        <div className="sps-cmp-spacer" />
        <div className="sps-cmp-head">
          <span className="sps-cmp-swatch" style={{ background: a.accent }} />
          <Picker slot={0} val={a.productId} side="a" />
          {a.recommended && <span className="sps-cmp-badge">★ Recommended</span>}
        </div>
        <div className="sps-cmp-head">
          <span className="sps-cmp-swatch" style={{ background: b.accent }} />
          <Picker slot={1} val={b.productId} side="b" />
          {b.recommended && <span className="sps-cmp-badge">★ Recommended</span>}
        </div>
      </div>

      <div className="sps-cmp-rows">
        <div className="sps-cmp-row sps-cmp-chem">
          <div className="sps-cmp-label">Chemistry</div>
          <div className="sps-cmp-val">{a.chemistry}</div>
          <div className="sps-cmp-val">{b.chemistry}</div>
        </div>
        {rows.map((r) => {
          const aWins = r.lowerBetter ? r.av < r.bv : r.av > r.bv;
          const bWins = r.lowerBetter ? r.bv < r.av : r.bv > r.av;
          return (
            <div className="sps-cmp-row" key={r.label}>
              <div className="sps-cmp-label">{r.label}</div>
              <div className={"sps-cmp-val" + (aWins ? " win" : "")}>{r.fmt(r.av)}</div>
              <div className={"sps-cmp-val" + (bWins ? " win" : "")}>{r.fmt(r.bv)}</div>
            </div>
          );
        })}
        <div className="sps-cmp-row sps-cmp-feats">
          <div className="sps-cmp-label">Top features</div>
          <ul className="sps-cmp-val sps-cmp-featlist">
            {a.features.slice(0, 3).map((f, i) => <li key={i}>{f}</li>)}
          </ul>
          <ul className="sps-cmp-val sps-cmp-featlist">
            {b.features.slice(0, 3).map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── Component-scoped CSS ─────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap');

.sps-root{
  --bg:#0a0712;--card:#150f1f;--card-2:#1c1530;
  --line:rgba(255,255,255,0.08);--line-2:rgba(255,255,255,0.14);
  --text:#ece8f5;--text-dim:#8a8199;
  --accent:#8b5cf6;--accent-bright:#a78bfa;--accent-deep:#6d28d9;
  --solar:#ffd86b;--battery:#8b5cf6;--grid:#ef4444;--export:#38bdf8;--ev:#f472b6;
  --font-head:'Space Grotesk',system-ui,-apple-system,sans-serif;
  --font-mono:'JetBrains Mono','SF Mono',Consolas,monospace;
  --font-body:'Inter',system-ui,-apple-system,sans-serif;
  position:fixed;inset:0;z-index:5000;color:var(--text);
  font-family:var(--font-body);
  background:
    radial-gradient(1200px 700px at 78% -12%, rgba(139,92,246,.22), transparent 60%),
    radial-gradient(900px 560px at -8% 112%, rgba(109,40,217,.18), transparent 60%),
    radial-gradient(700px 500px at 50% 50%, rgba(167,139,250,.05), transparent 70%),
    linear-gradient(165deg,#0a0712 0%,#0f0a1c 55%,#140d24 100%);
  overflow:hidden;display:flex;flex-direction:column;
  -webkit-font-smoothing:antialiased;}

/* atmosphere: grain + radial vignette */
.sps-grain{position:absolute;inset:0;pointer-events:none;z-index:2;
  opacity:.035;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
.sps-vignette{position:absolute;inset:0;pointer-events:none;z-index:1;
  box-shadow:inset 0 0 120px 30px rgba(0,0,0,0.55);}

.sps-close{position:absolute;top:max(14px,env(safe-area-inset-top));right:16px;z-index:30;
  width:42px;height:42px;border-radius:50%;border:1px solid var(--line-2);
  background:rgba(255,255,255,.05);color:var(--text);font-size:18px;cursor:pointer;
  backdrop-filter:blur(8px);transition:background .2s,border-color .2s,transform .1s;}
.sps-close:hover{background:rgba(139,92,246,.18);border-color:var(--accent);}
.sps-close:active{transform:scale(.94);}

.sps-stage{flex:1;min-height:0;overflow:hidden;position:relative;z-index:3;}
.sps-track{display:flex;height:100%;width:100%;
  transition:transform .55s cubic-bezier(.22,1,.36,1);}
.sps-slide{flex:0 0 100%;width:100%;height:100%;overflow-y:auto;
  display:flex;align-items:center;justify-content:center;
  padding:clamp(16px,4vw,48px);}
.sps-inner{width:100%;max-width:940px;display:flex;flex-direction:column;
  align-items:center;gap:clamp(13px,2.4vh,24px);text-align:center;}

/* staggered entrance */
.sps-rise>*{opacity:0;transform:translateY(16px);}
.sps-rise.in>*{animation:sps-rise .7s cubic-bezier(.22,1,.36,1) forwards;}
.sps-rise.in>*:nth-child(1){animation-delay:.04s;}
.sps-rise.in>*:nth-child(2){animation-delay:.10s;}
.sps-rise.in>*:nth-child(3){animation-delay:.16s;}
.sps-rise.in>*:nth-child(4){animation-delay:.22s;}
.sps-rise.in>*:nth-child(5){animation-delay:.28s;}
.sps-rise.in>*:nth-child(6){animation-delay:.34s;}
@keyframes sps-rise{to{opacity:1;transform:none;}}

/* typography */
.sps-eyebrow{font-family:var(--font-mono);font-size:10px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--text-dim);font-weight:500;}
.sps-eyebrow::before{content:'·';margin-right:8px;color:var(--accent);}
.sps-h2{font-family:var(--font-head);
  font-size:clamp(23px,4.6vw,40px);font-weight:600;letter-spacing:-.02em;line-height:1.1;
  background:linear-gradient(135deg,#fff,var(--accent-bright));-webkit-background-clip:text;
  background-clip:text;color:transparent;margin:0;}
.sps-sub{color:var(--text-dim);font-size:13.5px;margin:-6px 0 0;}
.sps-tag{font-family:var(--font-mono);font-size:10px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--text-dim);margin-bottom:8px;}

/* ── Cover ── */
.sps-cover{gap:clamp(16px,3vh,34px);}
.sps-coverHero{width:min(560px,90vw);opacity:0;transform:translateY(24px) scale(.96);
  filter:drop-shadow(0 30px 60px rgba(109,40,217,.3));border-radius:18px;}
.sps-cover.in .sps-coverHero{animation:sps-rise .9s cubic-bezier(.22,1,.36,1) .1s forwards;}
.sps-coverText{opacity:0;transform:translateY(18px);}
.sps-cover.in .sps-coverText{animation:sps-rise .8s cubic-bezier(.22,1,.36,1) .45s forwards;}
.sps-title{font-family:var(--font-head);
  font-size:clamp(34px,8vw,70px);font-weight:700;line-height:1.02;letter-spacing:-.03em;
  background:linear-gradient(135deg,#fff 0%,var(--accent-bright) 55%,var(--accent) 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;margin:10px 0 0;}
.sps-coverName{font-family:var(--font-head);font-size:clamp(18px,3.2vw,26px);font-weight:600;margin-top:16px;}
.sps-coverAddr{font-family:var(--font-mono);color:var(--text-dim);font-size:12px;letter-spacing:.05em;margin-top:6px;}

/* ── Cover with a real photo of the home (full-bleed hero) ── */
.sps-coverPhoto{position:relative;justify-content:flex-end;align-items:flex-start;
  text-align:left;min-height:100%;padding:clamp(20px,5vh,48px) clamp(16px,4vw,40px);}
.sps-coverPhoto-bg{position:absolute;inset:0;z-index:0;overflow:hidden;border-radius:0;
  pointer-events:none;}
.sps-coverPhoto-img{position:absolute;inset:-4%;background-size:cover;background-position:center;
  transform:scale(1);transform-origin:center;}
.sps-coverPhoto.in .sps-coverPhoto-img{animation:sps-kenburns 18s ease forwards;}
@keyframes sps-kenburns{from{transform:scale(1);}to{transform:scale(1.08);}}
.sps-coverPhoto-scrim{position:absolute;inset:0;
  background:
    linear-gradient(180deg,rgba(10,7,18,.32) 0%,rgba(10,7,18,.52) 48%,rgba(10,7,18,.92) 100%),
    radial-gradient(120% 90% at 50% 0%,rgba(36,22,64,.25),transparent 60%);}
.sps-coverText-photo{position:relative;z-index:1;align-items:flex-start;text-align:left;
  width:min(940px,100%);}
.sps-coverText-photo .sps-title{text-align:left;}
.sps-coverTag{display:inline-block;font-family:var(--font-mono);font-size:9.5px;
  letter-spacing:.22em;text-transform:uppercase;color:var(--accent-bright);font-weight:600;
  padding:5px 11px;border-radius:999px;margin-bottom:12px;
  background:rgba(10,7,18,.5);border:1px solid var(--line-2);backdrop-filter:blur(8px);}

/* ── Real-home inset thumbnail on the interactive scene ── */
.sps-homeInset{position:absolute;right:14px;bottom:14px;z-index:6;
  width:clamp(120px,22vw,156px);border-radius:12px;overflow:hidden;
  border:1px solid var(--line-2);background:rgba(10,7,18,.6);
  box-shadow:0 10px 30px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter:blur(6px);animation:sps-fade .5s ease;}
.sps-homeInset img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;}
.sps-homeInset-label{position:absolute;left:7px;bottom:6px;font-family:var(--font-mono);
  font-size:8px;letter-spacing:.16em;color:#fff;font-weight:600;
  padding:3px 7px;border-radius:6px;background:rgba(10,7,18,.62);
  border:1px solid var(--line-2);backdrop-filter:blur(4px);}
@media(max-width:560px){.sps-homeInset{right:10px;bottom:10px;}}

/* ── Real-home night backdrop on the backup slide ── */
.sps-nightHome{position:relative;overflow:hidden;min-height:200px;}
.sps-nightHome-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;
  display:block;}
.sps-nightHome-scrim{position:absolute;inset:0;mix-blend-mode:multiply;
  background:linear-gradient(160deg,#1a2356 0%,#0b0f2e 60%,#06081c 100%);}
.sps-nightHome-glow{position:absolute;inset:0;
  background:radial-gradient(40% 32% at 50% 64%,rgba(255,214,128,.42),transparent 70%);
  mix-blend-mode:screen;animation:sps-lightsOn 5s ease-in-out infinite;}
@keyframes sps-lightsOn{0%,100%{opacity:.78;}50%{opacity:1;}}
.sps-nightHome-label{position:absolute;left:12px;bottom:10px;z-index:2;
  font-family:var(--font-mono);font-size:9px;letter-spacing:.18em;color:#ffe9a8;font-weight:600;
  padding:4px 9px;border-radius:7px;background:rgba(6,8,28,.55);
  border:1px solid var(--line-2);backdrop-filter:blur(5px);}

/* ── Interactive scene ── */
.sps-switcher{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}
.sps-scbtn{display:flex;align-items:center;gap:9px;font-family:var(--font-head);
  padding:9px 14px;min-width:120px;border-radius:11px;border:1px solid var(--line-2);
  background:rgba(255,255,255,.025);color:var(--text);cursor:pointer;
  text-align:left;line-height:1.15;transition:all .2s ease;min-height:46px;}
.sps-scbtn-ico{font-size:15px;opacity:.7;flex-shrink:0;}
.sps-scbtn-txt{display:flex;flex-direction:column;gap:2px;}
.sps-scbtn-label{font-size:12.5px;font-weight:600;}
.sps-scbtn-sub{font-family:var(--font-mono);font-size:8.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--text-dim);}
.sps-scbtn:hover{border-color:rgba(255,255,255,.26);background:rgba(255,255,255,.045);}
.sps-scbtn.on{background:rgba(139,92,246,.14);border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(139,92,246,.16);}
.sps-scbtn.on .sps-scbtn-ico{opacity:1;color:var(--accent-bright);}
.sps-scbtn.on .sps-scbtn-sub{color:var(--accent-bright);}

.sps-sceneWrap{position:relative;width:min(660px,94vw);
  background:var(--card);border:1px solid var(--line);
  border-radius:18px;padding:10px;overflow:hidden;
  box-shadow:0 24px 70px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.04);}
.sps-sceneWrap::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
  background:var(--accent);z-index:4;border-radius:3px 0 0 3px;}
.sps-theme-solar::before{background:var(--solar)!important;}
.sps-theme-battery::before{background:var(--battery)!important;}
.sps-theme-grid::before{background:var(--grid)!important;}
.sps-theme-export::before{background:var(--export)!important;}
.sps-theme-ev::before{background:var(--ev)!important;}
.sps-scene{width:100%;height:auto;display:block;border-radius:12px;}
.sps-video{width:100%;height:auto;display:block;border-radius:12px;}

/* HUD chips */
.sps-hud{position:absolute;top:14px;left:14px;z-index:5;display:flex;flex-direction:column;
  gap:6px;align-items:flex-start;animation:sps-fade .45s ease;}
.sps-chip{display:inline-flex;align-items:center;gap:7px;
  padding:5px 10px;border-radius:9px;
  background:rgba(10,7,18,.62);border:1px solid var(--line-2);
  backdrop-filter:blur(10px);font-family:var(--font-mono);}
.sps-chip-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.sps-chip-label{font-size:9px;letter-spacing:.16em;color:var(--text-dim);font-weight:500;}
.sps-chip-sep{font-size:8px;color:var(--text-dim);opacity:.6;}
.sps-chip-val{font-size:11px;font-weight:600;letter-spacing:.02em;}
.sps-chip-live{padding:5px 10px;}
.sps-live-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);
  box-shadow:0 0 6px var(--accent);animation:sps-pulse 1.6s ease-in-out infinite;}
.sps-chip-live .sps-chip-label{color:var(--accent-bright);}
@keyframes sps-pulse{0%,100%{opacity:1;box-shadow:0 0 6px var(--accent);}50%{opacity:.4;box-shadow:0 0 2px var(--accent);}}

.sps-daynight{position:absolute;top:14px;right:14px;z-index:6;
  display:flex;gap:5px;background:rgba(10,7,18,.65);border:1px solid var(--line-2);
  border-radius:999px;padding:4px;backdrop-filter:blur(8px);}
.sps-dnbtn{font-family:var(--font-mono);font-size:11px;font-weight:500;letter-spacing:.05em;
  padding:6px 13px;border-radius:999px;border:0;background:transparent;color:var(--text-dim);
  cursor:pointer;transition:all .2s;}
.sps-dnbtn.on{background:rgba(139,92,246,.22);color:#fff;box-shadow:0 0 0 1px var(--accent);}

.sps-legend{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;
  font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--text-dim);}
.sps-legend span{display:inline-flex;align-items:center;gap:6px;}
.sps-legend i{width:9px;height:9px;border-radius:3px;display:inline-block;}

.sps-caption{font-family:var(--font-body);font-size:clamp(15px,2.4vw,19px);line-height:1.5;
  color:#d6cfe6;max-width:640px;margin:0;animation:sps-fade .5s ease;}
@keyframes sps-fade{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}

/* ── SVG scene: neon marching-ants flows ── */
.sps-flow{fill:none;stroke-width:3.5;stroke-linecap:round;opacity:0;
  stroke-dasharray:10 14;transition:opacity .4s;pointer-events:none;}
.sps-flow.on{opacity:1;animation:sps-flowDash 1.6s linear infinite;}
.sps-flow.rev.on{animation-direction:reverse;}
.sps-flow.solar{stroke:var(--solar);filter:drop-shadow(0 0 8px var(--solar));}
.sps-flow.battery{stroke:var(--battery);filter:drop-shadow(0 0 8px var(--battery));}
.sps-flow.grid{stroke:var(--grid);filter:drop-shadow(0 0 8px var(--grid));}
.sps-flow.export{stroke:var(--export);filter:drop-shadow(0 0 8px var(--export));}
.sps-flow.ev{stroke:var(--ev);filter:drop-shadow(0 0 8px var(--ev));}
@keyframes sps-flowDash{to{stroke-dashoffset:-48;}}

.sps-svglabel{font-family:var(--font-mono);font-size:8px;letter-spacing:.15em;fill:var(--text-dim);}
.sps-outage{font-family:var(--font-mono);font-size:8px;letter-spacing:.1em;
  animation:sps-blink 1.2s step-end infinite;}
@keyframes sps-blink{50%{opacity:.3;}}

.sps-sun{opacity:.55;transition:opacity .6s,transform .6s;}
.sps-sun.on{opacity:1;animation:sps-sunpulse 4s ease-in-out infinite;}
@keyframes sps-sunpulse{0%,100%{transform:scale(1);}50%{transform:scale(1.05);}}

.sps-star{opacity:.3;animation:sps-twinkle 2.4s ease-in-out infinite;}
@keyframes sps-twinkle{0%,100%{opacity:.25;}50%{opacity:1;}}

.sps-window{fill:#1a1330;transition:fill .5s;}
.sps-window.lit{fill:#ffe9a8;animation:sps-glow 3s ease-in-out infinite;}
@keyframes sps-glow{0%,100%{fill:#ffd86b;}50%{fill:#ffe9a8;}}

.sps-panels{opacity:.5;transition:opacity .5s;}
.sps-panels.active{opacity:1;}
.sps-shine{opacity:0;animation:sps-shine 3.5s ease-in-out infinite;}
@keyframes sps-shine{0%,70%,100%{opacity:0;}82%{opacity:.6;}}

.sps-batfill{transform:translateY(46px);}
.sps-batfill.filling{animation:sps-fill 3s ease-in-out infinite;}
.sps-batfill.full{transform:translateY(5px);}
@keyframes sps-fill{0%{transform:translateY(42px);}50%{transform:translateY(6px);}100%{transform:translateY(42px);}}

.sps-evcharge{transform:scaleX(0);transform-origin:left center;}
.sps-evcharge.on{animation:sps-evfill 2.6s ease-in-out infinite;}
@keyframes sps-evfill{0%{transform:scaleX(.1);}60%{transform:scaleX(1);}100%{transform:scaleX(.1);}}

.sps-grid.dark line{stroke:#211b30!important;transition:stroke .5s;}

/* night/outage atmosphere overlay via scene class (subtle tint already in gradients) */

/* ── Savings ── */
.sps-bignum{position:relative;overflow:hidden;background:var(--card);
  border:1px solid var(--line);border-radius:16px;
  padding:clamp(22px,4vw,40px);width:min(620px,92vw);
  box-shadow:0 24px 70px rgba(0,0,0,.5);}
.sps-bignum::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--battery);}
.sps-bignum-label{font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
  text-transform:uppercase;letter-spacing:.2em;}
.sps-bignum-value{font-family:var(--font-head);
  font-size:clamp(46px,11vw,88px);font-weight:700;line-height:1;margin:10px 0;letter-spacing:-.02em;
  background:linear-gradient(135deg,var(--accent),var(--accent-bright));
  -webkit-background-clip:text;background-clip:text;color:transparent;}
.sps-bignum-eq{font-family:var(--font-mono);font-size:11.5px;letter-spacing:.02em;color:var(--text-dim);}
.sps-bignum-eq strong{color:var(--text);font-weight:600;}
.sps-savegrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;width:min(620px,92vw);}
.sps-savecard{position:relative;overflow:hidden;background:var(--card);
  border:1px solid var(--line);border-radius:14px;padding:22px 16px;}
.sps-savecard::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent);}
.sps-saveval{display:flex;align-items:center;justify-content:center;gap:9px;
  font-family:var(--font-head);font-size:clamp(26px,6vw,40px);font-weight:700;line-height:1;}
.sps-save-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
.sps-savelabel{font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--text-dim);margin-top:10px;}
@media(max-width:520px){.sps-savegrid{grid-template-columns:1fr;}}

/* ── Backup ── */
.sps-backupGrid{display:grid;grid-template-columns:1fr 1fr;gap:22px;
  width:min(880px,94vw);align-items:center;}
.sps-miniScene{position:relative;overflow:hidden;background:var(--card);
  border:1px solid var(--line);border-radius:16px;padding:8px;
  box-shadow:0 18px 50px rgba(0,0,0,.45);}
.sps-syscard{position:relative;overflow:hidden;text-align:left;background:var(--card);
  border:1px solid var(--line);border-radius:16px;padding:22px;}
.sps-syscard::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--battery);}
.sps-sysname{font-family:var(--font-head);font-size:21px;font-weight:600;letter-spacing:-.02em;}
.sps-sysstats{display:flex;gap:22px;margin:18px 0;}
.sps-sysn{font-family:var(--font-mono);font-size:30px;font-weight:700;
  color:var(--accent-bright);line-height:1;}
.sps-sysl{font-family:var(--font-mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--text-dim);margin-top:6px;}
.sps-syslead{font-family:var(--font-body);font-size:14px;line-height:1.55;color:#c8c3b3;margin:0;}
@media(max-width:680px){.sps-backupGrid{grid-template-columns:1fr;}}

/* ── Incentives ── */
.sps-inclist{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
  gap:14px;width:min(880px,94vw);
  max-height:min(62vh,560px);overflow-y:auto;padding:2px;align-content:start;
  align-items:start;justify-items:stretch;}
.sps-inccard{position:relative;overflow:hidden;display:flex;flex-direction:column;
  align-items:flex-start;min-width:0;background:var(--card);
  border:1px solid var(--line);border-radius:14px;padding:18px 18px 18px 20px;text-align:left;
  transition:border-color .25s,transform .25s;animation:sps-rise .6s cubic-bezier(.22,1,.36,1) backwards;}
.sps-inccard::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--solar);}
.sps-inccard:hover{border-color:var(--line-2);transform:translateY(-2px);}
.sps-incName{font-family:var(--font-head);font-weight:600;font-size:15px;letter-spacing:-.01em;
  line-height:1.3;max-width:100%;overflow-wrap:anywhere;word-break:break-word;}
.sps-incAmt{display:inline-block;max-width:100%;margin-top:10px;
  font-family:var(--font-mono);background:rgba(255,216,107,.14);
  color:var(--solar);font-weight:600;font-size:11px;line-height:1.4;padding:4px 10px;border-radius:8px;
  white-space:normal;overflow-wrap:anywhere;word-break:break-word;
  border:1px solid rgba(255,216,107,.3);}
.sps-incMeta{font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;color:var(--text-dim);
  margin-top:10px;max-width:100%;overflow-wrap:anywhere;word-break:break-word;}
.sps-incLink{display:inline-block;margin-top:12px;font-family:var(--font-mono);font-size:11px;
  letter-spacing:.05em;color:var(--accent-bright);font-weight:500;}

/* ── CTA ── */
.sps-cta{position:relative;justify-content:center;min-height:60vh;}
.sps-ctaGlow{position:absolute;inset:-40% 0 auto;height:480px;
  background:radial-gradient(closest-side,rgba(139,92,246,.28),transparent);
  pointer-events:none;animation:sps-sunpulse 6s ease-in-out infinite;}
.sps-ctaTitle{position:relative;font-family:var(--font-head);
  font-size:clamp(32px,7vw,62px);font-weight:700;letter-spacing:-.03em;
  background:linear-gradient(135deg,#fff,var(--accent-bright));-webkit-background-clip:text;
  background-clip:text;color:transparent;margin:0;}
.sps-ctaSub{position:relative;font-family:var(--font-body);font-size:clamp(16px,3vw,22px);
  color:#d6cfe6;max-width:560px;margin:6px 0 0;}
.sps-ctaLine{position:relative;font-family:var(--font-mono);font-size:13px;letter-spacing:.03em;
  color:var(--accent-bright);margin:0;font-weight:500;}
.sps-ctaCompany{position:relative;margin-top:22px;font-family:var(--font-mono);font-size:11px;
  letter-spacing:.2em;text-transform:uppercase;color:var(--text-dim);font-weight:500;}

/* ── Nav controls ── */
.sps-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:20;
  width:48px;height:48px;border-radius:50%;border:1px solid var(--line-2);
  background:rgba(255,255,255,.05);color:var(--text);font-size:26px;line-height:1;cursor:pointer;
  backdrop-filter:blur(8px);transition:background .2s,border-color .2s,transform .1s;
  display:flex;align-items:center;justify-content:center;}
.sps-nav:hover:not(:disabled){background:rgba(139,92,246,.18);border-color:var(--accent);}
.sps-nav:active:not(:disabled){transform:translateY(-50%) scale(.92);}
.sps-nav:disabled{opacity:.22;cursor:default;}
.sps-nav.prev{left:14px;}
.sps-nav.next{right:14px;}

.sps-dots{position:absolute;bottom:max(18px,env(safe-area-inset-bottom));left:50%;
  transform:translateX(-50%);z-index:20;display:flex;gap:10px;}
.sps-dot{width:9px;height:9px;border-radius:50%;border:0;cursor:pointer;
  background:rgba(255,255,255,.22);transition:all .25s;padding:0;}
.sps-dot.on{background:var(--accent-bright);width:26px;border-radius:999px;
  box-shadow:0 0 12px rgba(139,92,246,.7);}

@media(max-width:560px){
  .sps-nav{width:40px;height:40px;font-size:22px;}
  .sps-nav.prev{left:8px;}
  .sps-nav.next{right:8px;}
  .sps-hud{top:10px;left:10px;}
  .sps-scbtn{min-width:calc(50% - 4px);flex:1 1 calc(50% - 4px);}
}

/* ── CRM: battery selector ── */
.sps-batsel{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;width:min(940px,96vw);}
.sps-batsel-item{position:relative;display:flex;align-items:center;gap:10px;
  padding:9px 13px;border-radius:12px;border:1px solid var(--line-2);
  background:rgba(255,255,255,.025);color:var(--text);cursor:pointer;text-align:left;
  transition:border-color .2s,background .2s,box-shadow .2s,transform .1s;min-height:48px;}
.sps-batsel-item:hover{background:rgba(255,255,255,.05);}
.sps-batsel-item:active{transform:scale(.98);}
.sps-batsel-item.on{background:rgba(255,255,255,.06);}
.sps-batsel-swatch{width:14px;height:22px;border-radius:4px;flex-shrink:0;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);}
.sps-batsel-txt{display:flex;flex-direction:column;gap:2px;}
.sps-batsel-name{font-family:var(--font-head);font-size:13px;font-weight:600;line-height:1.1;}
.sps-batsel-kwh{font-family:var(--font-mono);font-size:9px;letter-spacing:.08em;color:var(--text-dim);}
.sps-batsel-badge{font-family:var(--font-mono);font-size:8px;letter-spacing:.1em;font-weight:600;
  color:#06121f;background:linear-gradient(135deg,#ffe9a8,var(--solar));
  padding:3px 7px;border-radius:999px;margin-left:2px;white-space:nowrap;}

/* ── CRM: interactive 3D / AR ── */
.sps-3dwrap{position:relative;width:min(620px,94vw);aspect-ratio:4/5;max-height:62vh;
  background:radial-gradient(120% 100% at 50% 30%,rgba(255,255,255,.05),rgba(10,7,18,.6));
  border:1px solid var(--line);border-radius:20px;overflow:hidden;
  box-shadow:0 24px 70px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05);}
.sps-3dwrap::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
  background:var(--accent);z-index:4;border-radius:3px 0 0 3px;}
.sps-3dwrap model-viewer{width:100%;height:100%;display:block;}
.sps-3dover{position:absolute;left:0;right:0;top:0;z-index:3;padding:14px 16px;
  display:flex;flex-direction:column;gap:6px;pointer-events:none;
  background:linear-gradient(180deg,rgba(10,7,18,.55),transparent);}
.sps-3dname{font-family:var(--font-head);font-size:clamp(15px,2.6vw,20px);font-weight:600;
  text-align:left;letter-spacing:-.01em;}
.sps-3dspecs{display:flex;flex-wrap:wrap;gap:6px 14px;font-family:var(--font-mono);
  font-size:10.5px;letter-spacing:.04em;color:var(--text-dim);}
.sps-3dspecs b{color:var(--accent-bright);font-weight:700;font-size:13px;}
.sps-arbtn{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:5;
  font-family:var(--font-head);font-size:13px;font-weight:600;letter-spacing:.01em;
  padding:11px 18px;border-radius:999px;border:1px solid var(--accent);color:#fff;cursor:pointer;
  background:rgba(10,7,18,.7);backdrop-filter:blur(8px);transition:background .2s,transform .1s;
  white-space:nowrap;}
.sps-arbtn:hover{background:rgba(139,92,246,.28);}
.sps-arbtn:active{transform:translateX(-50%) scale(.96);}
.sps-3dnote{position:absolute;left:0;right:0;bottom:60px;z-index:5;text-align:center;
  font-family:var(--font-mono);font-size:10px;letter-spacing:.06em;color:var(--text-dim);}
/* CSS/SVG fallback battery */
.sps-batfb{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:12px;padding:20px;}
.sps-batfb-svg{width:auto;height:62%;max-width:60%;
  filter:drop-shadow(0 12px 30px rgba(0,0,0,.5));}
.sps-batfb-charge{animation:sps-fbpulse 2.4s ease-in-out infinite;transform-origin:center bottom;}
@keyframes sps-fbpulse{0%,100%{opacity:.65;}50%{opacity:1;}}
.sps-batfb-label{font-family:var(--font-head);font-size:15px;font-weight:600;}

/* ── CRM: features & benefits ── */
.sps-activePill{display:inline-flex;align-items:center;gap:8px;align-self:center;
  font-family:var(--font-mono);font-size:11px;letter-spacing:.06em;
  padding:6px 13px;border-radius:999px;border:1px solid var(--line-2);
  background:rgba(10,7,18,.5);}
.sps-activePill-dot{width:8px;height:8px;border-radius:50%;}
.sps-crm{display:grid;grid-template-columns:1fr 1fr;gap:16px;width:min(900px,96vw);text-align:left;}
.sps-crm-col{position:relative;overflow:hidden;background:var(--card);
  border:1px solid var(--line);border-radius:16px;padding:20px 22px;}
.sps-crm-col::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent);}
.sps-crm-tagline{font-family:var(--font-head);font-size:16px;font-weight:600;line-height:1.35;
  margin-bottom:14px;color:#efeaf8;}
.sps-crm-h{font-family:var(--font-mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;
  color:var(--text-dim);margin-bottom:10px;}
.sps-crm-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;}
.sps-crm-list li{display:flex;align-items:flex-start;gap:10px;font-family:var(--font-body);
  font-size:14px;line-height:1.45;color:#d6cfe6;}
.sps-crm-check{flex-shrink:0;font-size:13px;line-height:1.4;}
.sps-crm-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:6px;}
@media(max-width:680px){.sps-crm{grid-template-columns:1fr;}}

/* ── CRM: compare two ── */
.sps-cmp{width:min(900px,96vw);background:var(--card);border:1px solid var(--line);
  border-radius:16px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.5);}
.sps-cmp-heads,.sps-cmp-row{display:grid;grid-template-columns:1.2fr 1fr 1fr;}
.sps-cmp-heads{padding:14px 12px;border-bottom:1px solid var(--line);gap:8px;align-items:start;}
.sps-cmp-spacer{}
.sps-cmp-head{display:flex;flex-direction:column;align-items:center;gap:7px;text-align:center;}
.sps-cmp-swatch{width:26px;height:8px;border-radius:4px;}
.sps-cmp-pick{width:100%;max-width:170px;font-family:var(--font-head);font-size:12.5px;font-weight:600;
  padding:7px 9px;border-radius:9px;border:1px solid var(--line-2);
  background:var(--card-2);color:var(--text);cursor:pointer;}
.sps-cmp-badge{font-family:var(--font-mono);font-size:8px;letter-spacing:.1em;font-weight:600;
  color:#06121f;background:linear-gradient(135deg,#ffe9a8,var(--solar));
  padding:3px 7px;border-radius:999px;}
.sps-cmp-rows{display:flex;flex-direction:column;}
.sps-cmp-row{padding:11px 12px;gap:8px;align-items:center;border-bottom:1px solid var(--line);}
.sps-cmp-row:last-child{border-bottom:0;}
.sps-cmp-row:nth-child(even){background:rgba(255,255,255,.015);}
.sps-cmp-label{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--text-dim);}
.sps-cmp-val{font-family:var(--font-head);font-size:14px;font-weight:600;text-align:center;
  color:#d6cfe6;}
.sps-cmp-val.win{color:#fff;}
.sps-cmp-val.win::after{content:'▲';font-size:8px;margin-left:6px;color:#34d399;
  vertical-align:middle;}
.sps-cmp-feats{align-items:start;}
.sps-cmp-featlist{list-style:none;margin:0;padding:0;text-align:left;font-family:var(--font-body);
  font-size:11.5px;font-weight:400;line-height:1.4;color:var(--text-dim);
  display:flex;flex-direction:column;gap:5px;}
.sps-cmp-featlist li{position:relative;padding-left:12px;}
.sps-cmp-featlist li::before{content:'·';position:absolute;left:2px;color:var(--accent-bright);}
@media(max-width:560px){
  .sps-cmp-label{font-size:9px;}
  .sps-cmp-val{font-size:12px;}
  .sps-cmp-pick{font-size:11px;}
  .sps-cmp-featlist{font-size:10px;}
}

@media(prefers-reduced-motion:reduce){
  .sps-batfb-charge{animation:none!important;opacity:.9;}
  .sps-flow.on,.sps-flow.rev.on{animation:none!important;opacity:1;}
  .sps-sun.on,.sps-window.lit,.sps-shine,.sps-batfill.filling,
  .sps-evcharge.on,.sps-star,.sps-outage,.sps-ctaGlow,.sps-live-dot,.sps-grain{animation:none!important;}
  .sps-batfill.filling{transform:translateY(6px);}
  .sps-evcharge.on{transform:scaleX(1);}
  .sps-track{transition:none;}
  .sps-rise>*,.sps-inccard{opacity:1!important;transform:none!important;animation:none!important;}
  .sps-cover .sps-coverHero,.sps-cover .sps-coverText{opacity:1!important;transform:none!important;animation:none!important;}
  .sps-coverPhoto.in .sps-coverPhoto-img{animation:none!important;transform:scale(1.04);}
  .sps-nightHome-glow{animation:none!important;opacity:.9;}
  .sps-homeInset{animation:none!important;}
}
`;
