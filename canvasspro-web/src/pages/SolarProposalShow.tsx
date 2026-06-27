import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// SolarProposalShow — a full-screen, client-side, presenter-driven slide deck a
// closer plays for a homeowner at the kitchen table. Pure React + inline SVG +
// CSS keyframes — no external animation libraries. The centerpiece is an
// interactive home scene whose energy flows morph between four scenarios.
// ─────────────────────────────────────────────────────────────────────────────

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
}

type Scenario = "nosolar" | "solar" | "battery" | "ev";

const PALETTE = {
  gold: "#fbbf24",
  goldDim: "#a8821f",
  green: "#34d399",
  blue: "#38bdf8",
  amber: "#f59e0b",
  ink: "#e8eef8",
  inkMid: "#a8b3c7",
  inkDim: "#6b7589",
};

const money0 = (n: number | undefined | null) =>
  typeof n === "number" && isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—";

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
  const flowGridToHome = (scenario === "nosolar") || (!solarActive) || (isNight ? false : false);
  // grid → home active when: no solar at all, OR daytime grid top-up is not the story.
  const gridFlow = scenario === "nosolar"; // amber, grid → home
  const solarToHome = solarActive && !isNight;
  const solarToGrid = scenario === "solar" && !isNight; // export
  const solarToBattery = batteryActive && !isNight; // charging
  const batteryToHome = batteryActive && isNight; // discharging at night
  const toEv = evActive && (isNight ? batteryToHome : solarActive); // car charging

  void flowGridToHome;

  return (
    <svg
      className="sps-scene"
      viewBox="0 0 400 260"
      role="img"
      aria-label="Home energy scene"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="sps-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={isNight ? "#0a1228" : "#13315e"} />
          <stop offset="1" stopColor={isNight ? "#070b18" : "#1d3a66"} />
        </linearGradient>
        <linearGradient id="sps-roof" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a4a66" />
          <stop offset="1" stopColor="#27344c" />
        </linearGradient>
        <radialGradient id="sps-sunglow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fde68a" stopOpacity="0.9" />
          <stop offset="1" stopColor="#fbbf24" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sps-panel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1e3a5f" />
          <stop offset="1" stopColor="#0f2240" />
        </linearGradient>
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
        <circle cx="330" cy="48" r="42" fill="url(#sps-sunglow)" />
        <circle
          cx="330"
          cy="48"
          r="18"
          fill={isNight ? "#cdd6f4" : "#fde68a"}
          stroke={isNight ? "#9aa6d4" : "#fbbf24"}
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
                stroke="#fcd34d"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            );
          })}
      </g>

      {/* ground */}
      <rect x="0" y="206" width="400" height="54" fill={isNight ? "#0c1322" : "#16243d"} />

      {/* ── Grid: pole + power lines (left) ── */}
      <g className={"sps-grid" + (gridDark ? " dark" : "")}>
        <line x1="28" y1="120" x2="28" y2="206" stroke="#5a6b86" strokeWidth="4" strokeLinecap="round" />
        <line x1="14" y1="128" x2="42" y2="128" stroke="#5a6b86" strokeWidth="3" strokeLinecap="round" />
        <line x1="14" y1="138" x2="42" y2="138" stroke="#5a6b86" strokeWidth="3" strokeLinecap="round" />
        {/* slack wire toward the house */}
        <path d="M28 130 Q70 150 110 150" fill="none" stroke="#3f4d64" strokeWidth="2" />
        <text x="28" y="200" textAnchor="middle" fontSize="9" fill={PALETTE.inkDim}>
          GRID
        </text>
        {gridDark && (
          <text x="28" y="112" textAnchor="middle" fontSize="9" fill={PALETTE.amber} className="sps-outage">
            ⚠ OUTAGE
          </text>
        )}
      </g>

      {/* ── House ── */}
      <g>
        {/* body */}
        <rect x="150" y="130" width="120" height="76" rx="3" fill={isNight ? "#1a2335" : "#26344e"} />
        {/* roof */}
        <polygon points="142,132 210,96 278,132" fill="url(#sps-roof)" />
        {/* door */}
        <rect x="200" y="168" width="20" height="38" rx="2" fill={isNight ? "#0e1626" : "#1a2740"} />
        {/* windows — glow when powered */}
        {[
          [164, 150],
          [236, 150],
          [164, 178],
        ].map(([x, y], i) => {
          // home is lit unless it's a full outage with no battery (never happens here:
          // in battery/ev night the battery keeps it lit). In plain nosolar/solar it's day-lit.
          const lit = true;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width="20"
              height="18"
              rx="2"
              className={"sps-window" + (lit ? " lit" : "")}
              style={{ animationDelay: `${i * 0.2}s` }}
            />
          );
        })}

        {/* roof solar panels */}
        <g className={"sps-panels" + (solarActive && !isNight ? " active" : "")}>
          {[0, 1, 2, 3].map((i) => (
            <g key={i} transform={`translate(${168 + i * 18}, ${112 - i * 0}) `}>
              <polygon
                points={`${0},${8 + 0} ${14},${4} ${14},${16} ${0},${20}`}
                fill="url(#sps-panel)"
                stroke="#0a1a30"
                strokeWidth="0.6"
              />
            </g>
          ))}
          {/* shine sweep when active */}
          {solarActive && !isNight && <polygon className="sps-shine" points="168,118 240,98 240,104 168,124" fill="#bfe3ff" />}
        </g>
      </g>

      {/* ── Wall battery (right of house) ── */}
      <g className={"sps-battery" + (batteryActive ? " active" : "")}>
        <rect x="288" y="150" width="26" height="46" rx="4" fill="#13233c" stroke={batteryActive ? PALETTE.blue : "#33415c"} strokeWidth="1.5" />
        {/* fill level: charging by day, draining isn't animated (kept full-ish at night) */}
        <clipPath id="sps-batclip">
          <rect x="290" y="152" width="22" height="42" rx="3" />
        </clipPath>
        <g clipPath="url(#sps-batclip)">
          <rect
            className={
              "sps-batfill" +
              (batteryActive && !isNight ? " filling" : "") +
              (batteryActive && isNight ? " full" : "")
            }
            x="290"
            y="152"
            width="22"
            height="42"
            fill={PALETTE.blue}
          />
        </g>
        <text x="301" y="208" textAnchor="middle" fontSize="8" fill={batteryActive ? PALETTE.blue : PALETTE.inkDim}>
          BATTERY
        </text>
      </g>

      {/* ── EV in driveway ── */}
      {hasEv && (
        <g className={"sps-ev" + (evActive ? " active" : "")} transform="translate(96, 178)">
          {/* car body */}
          <rect x="0" y="10" width="46" height="16" rx="6" fill={evActive ? "#1f3a55" : "#1a2335"} stroke={evActive ? PALETTE.green : "#33415c"} strokeWidth="1.2" />
          <path d="M8 10 Q14 0 24 0 L34 0 Q40 2 42 10 Z" fill={evActive ? "#274a6b" : "#1a2335"} />
          <circle cx="12" cy="27" r="5" fill="#0c1322" stroke="#475569" strokeWidth="1.5" />
          <circle cx="36" cy="27" r="5" fill="#0c1322" stroke="#475569" strokeWidth="1.5" />
          {/* charge bar above the car */}
          <rect x="6" y="-9" width="34" height="5" rx="2.5" fill="#0c1322" stroke="#33415c" strokeWidth="0.8" />
          <rect className={"sps-evcharge" + (evActive ? " on" : "")} x="7" y="-8" width="32" height="3" rx="1.5" fill={PALETTE.green} />
        </g>
      )}

      {/* ════ ENERGY FLOW PATHS (marching ants) ════ */}
      {/* grid → home (amber) */}
      <path
        className={"sps-flow amber" + (gridFlow ? " on" : "")}
        d="M44 150 Q100 150 150 160"
        fill="none"
      />
      {/* solar(panels) → home (green) */}
      <path
        className={"sps-flow green" + (solarToHome ? " on" : "")}
        d="M205 110 L205 150"
        fill="none"
      />
      {/* solar → grid export (green, flowing left) */}
      <path
        className={"sps-flow green rev" + (solarToGrid ? " on" : "")}
        d="M150 140 Q100 140 44 138"
        fill="none"
      />
      {/* solar → battery (blue) */}
      <path
        className={"sps-flow blue" + (solarToBattery ? " on" : "")}
        d="M250 120 Q290 120 300 150"
        fill="none"
      />
      {/* battery → home (blue, flowing left into house) */}
      <path
        className={"sps-flow blue rev" + (batteryToHome ? " on" : "")}
        d="M288 172 L270 172"
        fill="none"
      />
      {/* power → EV (green) */}
      {hasEv && (
        <path
          className={"sps-flow green rev" + (toEv ? " on" : "")}
          d="M150 188 Q130 188 142 188"
          fill="none"
        />
      )}
      {hasEv && (
        <path
          className={"sps-flow green rev" + (toEv ? " on" : "")}
          d="M150 190 L142 190"
          fill="none"
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
    recommendation,
    roi,
    incentives,
    hasEv = false,
    hasExistingSolar = false,
    videoUrls,
  } = props;

  const [idx, setIdx] = useState(0);
  // The interactive home scenario + day/night.
  const [scenario, setScenario] = useState<Scenario>("nosolar");
  const [night, setNight] = useState(false);

  const reduceMotion = useRef(false);
  useEffect(() => {
    reduceMotion.current =
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // Build the slide list — hide the savings slide if there's no roi data.
  const slides = useMemo(() => {
    const list: Array<{ key: string }> = [
      { key: "cover" },
      { key: "interactive" },
    ];
    if (roi) list.push({ key: "savings" });
    if (recommendation) list.push({ key: "backup" });
    if (incentives && incentives.length) list.push({ key: "incentives" });
    list.push({ key: "cta" });
    return list;
  }, [roi, recommendation, incentives]);

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
    }
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
  const netUp = useCountUp(roi?.netCost, open && activeKey === "savings");
  const moUp = useCountUp(roi?.monthlySavings, open && activeKey === "savings", 900);
  const lifeUp = useCountUp(roi?.lifetimeSavings, open && activeKey === "savings", 1400);

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

  const scenarioOptions: Array<{ key: Scenario; label: string }> = [
    { key: "nosolar", label: "No solar" },
    { key: "solar", label: "Solar" },
    { key: "battery", label: "Solar + Battery" },
    { key: "ev", label: "+ EV charger" },
  ];

  const videoForScenario = videoUrls?.[scenario];

  return (
    <div className="sps-root" role="dialog" aria-modal="true" aria-label="Interactive solar proposal">
      <style>{CSS}</style>

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
                <CoverSlide name={name} address={address} company={company} active={activeKey === "cover"} hasEv={hasEv} />
              )}

              {s.key === "interactive" && (
                <div className="sps-inner">
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
                        {o.label}
                      </button>
                    ))}
                  </div>

                  <div className="sps-sceneWrap">
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
                      <HomeScene scenario={scenario} night={night} hasEv={hasEv} />
                    )}

                    {(scenario === "battery" || scenario === "ev") && (
                      <div className="sps-daynight">
                        <button
                          className={"sps-dnbtn" + (!night ? " on" : "")}
                          onClick={() => setNight(false)}
                        >
                          ☀️ Day
                        </button>
                        <button
                          className={"sps-dnbtn" + (night ? " on" : "")}
                          onClick={() => setNight(true)}
                        >
                          🌙 Night
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="sps-legend">
                    <span><i style={{ background: PALETTE.amber }} /> Grid</span>
                    <span><i style={{ background: PALETTE.green }} /> Solar</span>
                    <span><i style={{ background: PALETTE.blue }} /> Battery</span>
                  </div>

                  <p className="sps-caption" key={scenario + String(night)}>
                    {scenarioCaption[scenario]}
                  </p>
                </div>
              )}

              {s.key === "savings" && roi && (
                <div className="sps-inner">
                  <h2 className="sps-h2">Your savings</h2>
                  <div className="sps-bignum">
                    <div className="sps-bignum-label">Net cost after incentives</div>
                    <div className="sps-bignum-value">{money0(netUp)}</div>
                    <div className="sps-bignum-eq">
                      {money0(roi.grossCost)} gross − {money0(roi.incentives)} incentives ={" "}
                      <strong>{money0(roi.netCost)}</strong>
                    </div>
                  </div>
                  <div className="sps-savegrid">
                    <div className="sps-savecard">
                      <div className="sps-saveval green">{money0(moUp)}</div>
                      <div className="sps-savelabel">Estimated monthly savings</div>
                    </div>
                    <div className="sps-savecard">
                      <div className="sps-saveval blue">{money0(lifeUp)}</div>
                      <div className="sps-savelabel">Lifetime savings</div>
                    </div>
                  </div>
                </div>
              )}

              {s.key === "backup" && recommendation && (
                <div className="sps-inner">
                  <h2 className="sps-h2">Peace of mind, day and night</h2>
                  <div className="sps-backupGrid">
                    <div className="sps-miniScene">
                      <HomeScene scenario="battery" night hasEv={false} />
                    </div>
                    <div className="sps-syscard">
                      <div className="sps-sysname">
                        {recommendation.units}× {recommendation.brand} {recommendation.model}
                      </div>
                      <div className="sps-sysstats">
                        <div>
                          <div className="sps-sysn">{recommendation.totalUsableKWh}</div>
                          <div className="sps-sysl">kWh usable</div>
                        </div>
                        <div>
                          <div className="sps-sysn">{recommendation.backupDaysAchieved}</div>
                          <div className="sps-sysl">days of backup</div>
                        </div>
                        <div>
                          <div className="sps-sysn">{recommendation.units}</div>
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
                <div className="sps-inner">
                  <h2 className="sps-h2">Your incentives</h2>
                  <p className="sps-sub">Verified from official sources.</p>
                  <div className="sps-inclist">
                    {incentives.map((inc, i) => (
                      <div className="sps-inccard" key={i}>
                        <div className="sps-incTop">
                          <span className="sps-incName">{inc.name}</span>
                          {inc.amount && <span className="sps-incAmt">{inc.amount}</span>}
                        </div>
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
                <div className="sps-inner sps-cta">
                  <div className="sps-ctaGlow" />
                  <h2 className="sps-ctaTitle">Let&rsquo;s do this, {name.split(" ")[0]}.</h2>
                  <p className="sps-ctaSub">
                    Lower bills, real backup, and energy on your terms — starting now.
                  </p>
                  {monthlyBill != null && roi?.monthlySavings != null && (
                    <p className="sps-ctaLine">
                      From {money0(monthlyBill)}/mo on the grid to about{" "}
                      {money0(roi.monthlySavings)}/mo back in your pocket.
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
}: {
  name: string;
  address?: string;
  company: string;
  active: boolean;
  hasEv: boolean;
}) {
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

// ── Component-scoped CSS ─────────────────────────────────────────────────────
const CSS = `
.sps-root{position:fixed;inset:0;z-index:5000;color:${PALETTE.ink};
  font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:
    radial-gradient(1100px 600px at 80% -10%, rgba(56,189,248,.18), transparent 60%),
    radial-gradient(900px 520px at -8% 110%, rgba(52,211,153,.12), transparent 60%),
    linear-gradient(160deg,#070b18 0%,#0c142a 55%,#101a33 100%);
  overflow:hidden;display:flex;flex-direction:column;
  -webkit-font-smoothing:antialiased;}
.sps-close{position:absolute;top:max(14px,env(safe-area-inset-top));right:16px;z-index:30;
  width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.18);
  background:rgba(255,255,255,.06);color:#e8eef8;font-size:18px;cursor:pointer;
  backdrop-filter:blur(8px);transition:background .2s,transform .1s;}
.sps-close:hover{background:rgba(255,255,255,.14);}
.sps-close:active{transform:scale(.94);}

.sps-stage{flex:1;min-height:0;overflow:hidden;position:relative;}
.sps-track{display:flex;height:100%;width:100%;
  transition:transform .5s cubic-bezier(.22,1,.36,1);}
.sps-slide{flex:0 0 100%;width:100%;height:100%;overflow-y:auto;
  display:flex;align-items:center;justify-content:center;
  padding:clamp(16px,4vw,48px);}
.sps-inner{width:100%;max-width:920px;display:flex;flex-direction:column;
  align-items:center;gap:clamp(14px,2.5vh,26px);text-align:center;}

.sps-h2{font-family:"Space Grotesk","Inter",sans-serif;
  font-size:clamp(22px,4.5vw,38px);font-weight:700;letter-spacing:-.5px;
  background:linear-gradient(135deg,#fff,#9fd2ff);-webkit-background-clip:text;
  background-clip:text;color:transparent;margin:0;}
.sps-sub{color:${PALETTE.inkMid};font-size:14px;margin:-8px 0 0;}

/* ── Cover ── */
.sps-cover{gap:clamp(16px,3vh,34px);}
.sps-coverHero{width:min(560px,90vw);opacity:0;transform:translateY(24px) scale(.96);}
.sps-cover.in .sps-coverHero{animation:sps-rise .9s cubic-bezier(.22,1,.36,1) .1s forwards;}
.sps-coverText{opacity:0;transform:translateY(18px);}
.sps-cover.in .sps-coverText{animation:sps-rise .8s cubic-bezier(.22,1,.36,1) .45s forwards;}
.sps-eyebrow{font-size:13px;letter-spacing:2px;text-transform:uppercase;
  color:${PALETTE.blue};font-weight:600;margin-bottom:10px;}
.sps-title{font-family:"Space Grotesk","Inter",sans-serif;
  font-size:clamp(34px,8vw,68px);font-weight:700;line-height:1.02;letter-spacing:-1px;
  background:linear-gradient(135deg,#fff 0%,#fcd34d 50%,#38bdf8 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;margin:0;}
.sps-coverName{font-size:clamp(18px,3.2vw,26px);font-weight:600;margin-top:16px;}
.sps-coverAddr{color:${PALETTE.inkMid};font-size:15px;margin-top:4px;}

@keyframes sps-rise{to{opacity:1;transform:none;}}

/* ── Interactive scene ── */
.sps-switcher{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}
.sps-scbtn{font-family:inherit;font-size:13px;font-weight:600;padding:9px 16px;
  border-radius:999px;border:1px solid rgba(255,255,255,.16);
  background:rgba(255,255,255,.04);color:${PALETTE.inkMid};cursor:pointer;
  transition:all .25s;min-height:40px;}
.sps-scbtn:hover{border-color:rgba(56,189,248,.5);color:#fff;}
.sps-scbtn.on{background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#00131f;
  border-color:transparent;box-shadow:0 6px 20px rgba(14,165,233,.35);}

.sps-sceneWrap{position:relative;width:min(640px,94vw);
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);
  border-radius:20px;padding:10px;box-shadow:0 20px 60px rgba(0,0,0,.4);
  backdrop-filter:blur(6px);}
.sps-scene{width:100%;height:auto;display:block;border-radius:14px;}
.sps-video{width:100%;height:auto;display:block;border-radius:14px;}

.sps-daynight{position:absolute;top:18px;left:50%;transform:translateX(-50%);
  display:flex;gap:6px;background:rgba(8,12,24,.6);border:1px solid rgba(255,255,255,.12);
  border-radius:999px;padding:4px;backdrop-filter:blur(6px);}
.sps-dnbtn{font-family:inherit;font-size:12px;font-weight:600;padding:6px 14px;
  border-radius:999px;border:0;background:transparent;color:${PALETTE.inkMid};cursor:pointer;
  transition:all .2s;}
.sps-dnbtn.on{background:rgba(255,255,255,.14);color:#fff;}

.sps-legend{display:flex;gap:18px;flex-wrap:wrap;justify-content:center;
  font-size:12px;color:${PALETTE.inkMid};}
.sps-legend span{display:inline-flex;align-items:center;gap:6px;}
.sps-legend i{width:12px;height:12px;border-radius:3px;display:inline-block;}

.sps-caption{font-size:clamp(15px,2.4vw,19px);line-height:1.5;color:#e8eef8;
  max-width:640px;margin:0;animation:sps-fade .5s ease;}
@keyframes sps-fade{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}

/* ── SVG scene animations ── */
.sps-flow{stroke-width:3;stroke-linecap:round;opacity:0;
  stroke-dasharray:6 9;transition:opacity .4s;pointer-events:none;}
.sps-flow.on{opacity:1;animation:sps-march 1s linear infinite;}
.sps-flow.rev.on{animation:sps-march-rev 1s linear infinite;}
.sps-flow.amber{stroke:${PALETTE.amber};filter:drop-shadow(0 0 3px rgba(245,158,11,.7));}
.sps-flow.green{stroke:${PALETTE.green};filter:drop-shadow(0 0 3px rgba(52,211,153,.7));}
.sps-flow.blue{stroke:${PALETTE.blue};filter:drop-shadow(0 0 3px rgba(56,189,248,.7));}
@keyframes sps-march{to{stroke-dashoffset:-30;}}
@keyframes sps-march-rev{to{stroke-dashoffset:30;}}

.sps-sun{opacity:.55;transition:opacity .6s,transform .6s;}
.sps-sun.on{opacity:1;animation:sps-sunpulse 4s ease-in-out infinite;}
@keyframes sps-sunpulse{0%,100%{transform:scale(1);}50%{transform:scale(1.05);}}

.sps-star{opacity:.3;animation:sps-twinkle 2.4s ease-in-out infinite;}
@keyframes sps-twinkle{0%,100%{opacity:.25;}50%{opacity:1;}}

.sps-window{fill:#1a2740;transition:fill .5s;}
.sps-window.lit{fill:#fde68a;animation:sps-glow 3s ease-in-out infinite;}
@keyframes sps-glow{0%,100%{fill:#fcd34d;}50%{fill:#fde68a;}}

.sps-panels{opacity:.5;transition:opacity .5s;}
.sps-panels.active{opacity:1;}
.sps-shine{opacity:0;animation:sps-shine 3.5s ease-in-out infinite;}
@keyframes sps-shine{0%,70%,100%{opacity:0;}82%{opacity:.55;}}

.sps-batfill{transform:translateY(42px);}
.sps-batfill.filling{animation:sps-fill 3s ease-in-out infinite;}
.sps-batfill.full{transform:translateY(4px);}
@keyframes sps-fill{0%{transform:translateY(38px);}50%{transform:translateY(6px);}100%{transform:translateY(38px);}}

.sps-evcharge{transform:scaleX(0);transform-origin:left center;}
.sps-evcharge.on{animation:sps-evfill 2.6s ease-in-out infinite;}
@keyframes sps-evfill{0%{transform:scaleX(.1);}60%{transform:scaleX(1);}100%{transform:scaleX(.1);}}

.sps-grid.dark line{stroke:#2a3346 !important;transition:stroke .5s;}
.sps-outage{animation:sps-blink 1.2s step-end infinite;}
@keyframes sps-blink{50%{opacity:.3;}}

/* ── Savings ── */
.sps-bignum{background:rgba(255,255,255,.04);border:1px solid rgba(56,189,248,.25);
  border-radius:20px;padding:clamp(20px,4vw,38px);width:min(620px,92vw);
  box-shadow:0 20px 60px rgba(0,0,0,.4);}
.sps-bignum-label{font-size:14px;color:${PALETTE.inkMid};text-transform:uppercase;
  letter-spacing:1px;}
.sps-bignum-value{font-family:"Space Grotesk","Inter",sans-serif;
  font-size:clamp(44px,11vw,84px);font-weight:700;line-height:1;margin:8px 0;
  background:linear-gradient(135deg,#fff,#38bdf8);-webkit-background-clip:text;
  background-clip:text;color:transparent;}
.sps-bignum-eq{font-size:14px;color:${PALETTE.inkMid};}
.sps-bignum-eq strong{color:#fff;}
.sps-savegrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;width:min(620px,92vw);}
.sps-savecard{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
  border-radius:16px;padding:22px 16px;}
.sps-saveval{font-family:"Space Grotesk","Inter",sans-serif;font-size:clamp(26px,6vw,40px);
  font-weight:700;line-height:1;}
.sps-saveval.green{color:${PALETTE.green};}
.sps-saveval.blue{color:${PALETTE.blue};}
.sps-savelabel{font-size:13px;color:${PALETTE.inkMid};margin-top:8px;}
@media(max-width:520px){.sps-savegrid{grid-template-columns:1fr;}}

/* ── Backup ── */
.sps-backupGrid{display:grid;grid-template-columns:1fr 1fr;gap:22px;
  width:min(860px,94vw);align-items:center;}
.sps-miniScene{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);
  border-radius:18px;padding:8px;}
.sps-syscard{text-align:left;background:rgba(255,255,255,.04);
  border:1px solid rgba(52,211,153,.25);border-radius:18px;padding:22px;}
.sps-sysname{font-family:"Space Grotesk","Inter",sans-serif;font-size:20px;font-weight:700;}
.sps-sysstats{display:flex;gap:20px;margin:16px 0;}
.sps-sysn{font-family:"Space Grotesk","Inter",sans-serif;font-size:30px;font-weight:700;
  color:${PALETTE.green};line-height:1;}
.sps-sysl{font-size:12px;color:${PALETTE.inkMid};margin-top:4px;}
.sps-syslead{font-size:15px;line-height:1.55;color:#dbe4f3;margin:0;}
@media(max-width:680px){.sps-backupGrid{grid-template-columns:1fr;}}

/* ── Incentives ── */
.sps-inclist{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));
  gap:14px;width:min(860px,94vw);}
.sps-inccard{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);
  border-radius:16px;padding:18px;text-align:left;
  transition:border-color .25s,transform .25s;}
.sps-inccard:hover{border-color:rgba(56,189,248,.4);transform:translateY(-2px);}
.sps-incTop{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;}
.sps-incName{font-weight:700;font-size:15px;}
.sps-incAmt{flex-shrink:0;background:linear-gradient(135deg,#34d399,#10b981);color:#06121f;
  font-weight:700;font-size:12px;padding:3px 10px;border-radius:999px;white-space:nowrap;}
.sps-incMeta{font-size:13px;color:${PALETTE.inkMid};margin-top:8px;}
.sps-incLink{display:inline-block;margin-top:10px;font-size:13px;color:${PALETTE.blue};
  font-weight:600;}

/* ── CTA ── */
.sps-cta{position:relative;justify-content:center;min-height:60vh;}
.sps-ctaGlow{position:absolute;inset:-40% 0 auto;height:480px;
  background:radial-gradient(closest-side,rgba(56,189,248,.22),transparent);
  pointer-events:none;animation:sps-sunpulse 6s ease-in-out infinite;}
.sps-ctaTitle{position:relative;font-family:"Space Grotesk","Inter",sans-serif;
  font-size:clamp(32px,7vw,60px);font-weight:700;letter-spacing:-1px;
  background:linear-gradient(135deg,#fff,#fcd34d);-webkit-background-clip:text;
  background-clip:text;color:transparent;margin:0;}
.sps-ctaSub{position:relative;font-size:clamp(16px,3vw,22px);color:#dbe4f3;
  max-width:560px;margin:6px 0 0;}
.sps-ctaLine{position:relative;font-size:15px;color:${PALETTE.blue};margin:0;font-weight:600;}
.sps-ctaCompany{position:relative;margin-top:22px;font-size:15px;letter-spacing:1px;
  text-transform:uppercase;color:${PALETTE.inkMid};font-weight:600;}

/* ── Nav controls ── */
.sps-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:20;
  width:48px;height:48px;border-radius:50%;border:1px solid rgba(255,255,255,.16);
  background:rgba(255,255,255,.06);color:#fff;font-size:26px;line-height:1;cursor:pointer;
  backdrop-filter:blur(8px);transition:background .2s,transform .1s;
  display:flex;align-items:center;justify-content:center;}
.sps-nav:hover:not(:disabled){background:rgba(255,255,255,.16);}
.sps-nav:active:not(:disabled){transform:translateY(-50%) scale(.92);}
.sps-nav:disabled{opacity:.25;cursor:default;}
.sps-nav.prev{left:14px;}
.sps-nav.next{right:14px;}

.sps-dots{position:absolute;bottom:max(18px,env(safe-area-inset-bottom));left:50%;
  transform:translateX(-50%);z-index:20;display:flex;gap:10px;}
.sps-dot{width:9px;height:9px;border-radius:50%;border:0;cursor:pointer;
  background:rgba(255,255,255,.25);transition:all .25s;padding:0;}
.sps-dot.on{background:#38bdf8;width:26px;border-radius:999px;
  box-shadow:0 0 12px rgba(56,189,248,.6);}

@media(max-width:560px){
  .sps-nav{width:40px;height:40px;font-size:22px;}
  .sps-nav.prev{left:8px;}
  .sps-nav.next{right:8px;}
}

@media(prefers-reduced-motion:reduce){
  .sps-flow.on,.sps-flow.rev.on{animation:none !important;opacity:1;}
  .sps-sun.on,.sps-window.lit,.sps-shine,.sps-batfill.filling,
  .sps-evcharge.on,.sps-star,.sps-outage,.sps-ctaGlow{animation:none !important;}
  .sps-batfill.filling{transform:translateY(6px);}
  .sps-evcharge.on{transform:scaleX(1);}
  .sps-track{transition:none;}
  .sps-cover .sps-coverHero,.sps-cover .sps-coverText{opacity:1 !important;transform:none !important;animation:none !important;}
}
`;
