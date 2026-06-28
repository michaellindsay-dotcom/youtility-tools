import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LivingEnergyScene from "./LivingEnergyScene";

// ─────────────────────────────────────────────────────────────────────────────
// SolarProposalShow — a full-screen, photography-led battery proposal a closer
// plays for a homeowner in the driveway or at the kitchen table. This is a
// magazine-quality, brand-campaign experience: full-bleed bundled photography
// behind every slide, cinematic dark scrims, slow Ken-Burns zooms, crossfades,
// glassmorphism cards floating over the imagery, mono eyebrows, and a faint film
// grain. The interactive centerpiece overlays animated neon energy-flow lines +
// live HUD chips on a scenario-switched photographic backdrop.
//
// Pure React + inline SVG + an injected <style> block — no external animation
// libraries. All classes are prefixed `sps-`. The two exported interfaces
// (ProposalOption, SolarShowProps) are consumed by BatteryTool.tsx and MUST keep
// their shape (optional fields may be added, never removed/renamed).
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
  // rendered full-bleed on the cover.
  homeImage?: string;
  homeImageIsStreetView?: boolean; // true → Street View, false → Satellite
  // Interactive CRM proposal: the full set of offered batteries the rep can pick
  // and compare. When present, the recommendation/savings/backup slides re-theme
  // to the selected battery and extra slides (3D/AR, features, compare) appear.
  // When absent/empty the show behaves exactly as before.
  options?: ProposalOption[];
  chosenProductId?: string; // the battery currently selected in the tool
}

// Energy palette — accent colors used by the savings/backup stat dots.
const PALETTE = {
  solar: "#ffd86b",
  battery: "#8b5cf6",
  grid: "#fbbf24",
  export: "#38bdf8",
  ev: "#f472b6",
  accent: "#8b5cf6",
  accentBright: "#a78bfa",
  text: "#ece8f5",
  textDim: "#9a92ab",
};

// ── Bundled photography ──────────────────────────────────────────────────────
// Served under the Vite base ("/app/" on web, "/" native) so paths resolve in
// both builds. import.meta.env.BASE_URL ends with a trailing slash.
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const PHOTO = {
  solar: `${BASE}/proposal/solar.jpg`, // modern home with rooftop solar
  energy: `${BASE}/proposal/energy.jpg`, // home energy unit + charger + EV
  ev: `${BASE}/proposal/ev.jpg`, // EV charging
  night: `${BASE}/proposal/night-home.jpg`, // two-story home at night, all lights on
  panels: `${BASE}/proposal/panels.jpg`, // solar panel detail / texture
};
const GLB = `${BASE}/battery.glb`;
const ALL_PHOTOS = [PHOTO.solar, PHOTO.energy, PHOTO.ev, PHOTO.night, PHOTO.panels];

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

// ── Full-bleed photographic backdrop with cinematic scrim + Ken-Burns ────────
// `src` may be undefined (or fail to load) — we always paint a dark gradient
// fallback underneath so text stays legible and nothing ever breaks.
function PhotoBackdrop({
  src,
  active,
  dim = false,
  position = "center",
  kenBurns = true,
}: {
  src?: string;
  active: boolean;
  dim?: boolean;
  position?: string;
  kenBurns?: boolean;
}) {
  const [ok, setOk] = useState(true);
  useEffect(() => {
    if (!src) {
      setOk(false);
      return;
    }
    setOk(true);
    const img = new Image();
    img.onload = () => setOk(true);
    img.onerror = () => setOk(false);
    img.src = src;
  }, [src]);

  return (
    <div className="sps-bg" aria-hidden="true">
      {ok && src && (
        <div
          key={src}
          className={"sps-bg-img" + (active && kenBurns ? " kb" : "")}
          style={{ backgroundImage: `url(${src})`, backgroundPosition: position }}
        />
      )}
      <div className={"sps-bg-scrim" + (dim ? " dim" : "")} />
    </div>
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
    homeImage,
    homeImageIsStreetView = false,
    options,
    chosenProductId,
  } = props;

  const hasOptions = !!(options && options.length);

  const [idx, setIdx] = useState(0);

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

  // Preload all bundled photography (and the customer's home photo) on open so
  // crossfades are instant. Failures are swallowed — PhotoBackdrop falls back.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const srcs = [...ALL_PHOTOS, homeImage].filter(Boolean) as string[];
    srcs.forEach((s) => {
      const img = new Image();
      img.src = s;
    });
  }, [open, homeImage]);

  // model-viewer load state: "idle" (not requested), "loading", "ready" (custom
  // element defined) or "failed" (didn't define in time → CSS/SVG fallback).
  const [mvState, setMvState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const mvRef = useRef<ModelViewerElement | null>(null);

  // Build the slide list — slides with no data are skipped gracefully.
  const slides = useMemo(() => {
    const list: Array<{ key: string }> = [
      { key: "cover" },
      { key: "interactive" },
    ];
    // CRM proposal slides — only when an option set is provided.
    if (hasOptions) {
      list.push({ key: "whybattery" });
      list.push({ key: "battery3d" });
    }
    if (effRoi) list.push({ key: "savings" });
    if (effRec) list.push({ key: "backup" });
    if (incentives && incentives.length) list.push({ key: "incentives" });
    if (hasOptions && (options?.length ?? 0) >= 2) list.push({ key: "compare" });
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
  const coverPhoto = homeImage || PHOTO.solar;

  return (
    <div
      className="sps-root"
      role="dialog"
      aria-modal="true"
      aria-label="Interactive solar proposal"
      style={{ ["--accent" as string]: brandAccent, ["--accent-bright" as string]: brandAccent }}
    >
      <style>{CSS}</style>

      {/* atmosphere overlays */}
      <div className="sps-grain" aria-hidden="true" />
      <div className="sps-vignette" aria-hidden="true" />

      <button className="sps-close" onClick={onClose} aria-label="Close presentation">
        ✕
      </button>

      {/* Slide viewport */}
      <div className="sps-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="sps-track" style={{ transform: `translateX(-${idx * 100}%)` }}>
          {slides.map((s) => {
            const isOn = slides[idx]?.key === s.key;
            return (
              <section className="sps-slide" key={s.key} aria-hidden={!isOn}>
                {/* ───────── 1. Cover ───────── */}
                {s.key === "cover" && (
                  <>
                    <PhotoBackdrop src={coverPhoto} active={isOn} position="center" />
                    <div className={"sps-inner sps-cover" + (isOn ? " in" : "")}>
                      <div className="sps-eyebrow sps-light">
                        Prepared for{company ? ` · ${company}` : ""}
                      </div>
                      <h1 className="sps-title">Your Energy Future</h1>
                      <div className="sps-coverName">{name}</div>
                      {address && <div className="sps-coverAddr">{address}</div>}
                      {homeImage && (
                        <div className="sps-coverTag">
                          YOUR HOME · {homeImageIsStreetView ? "STREET VIEW" : "SATELLITE"}
                        </div>
                      )}
                      <div className="sps-scrollHint">Swipe to begin →</div>
                    </div>
                  </>
                )}

                {/* ───────── 2. Interactive centerpiece ─────────
                    Photoreal "living energy system": a 3D-rendered home cutaway
                    with animated flows anchored to the real components, a live
                    status panel, scenario/mode switching and tap-to-learn
                    hotspots. Themed to the selected battery + fed real usage. */}
                {s.key === "interactive" && (
                  <LivingEnergyScene
                    accent={brandAccent}
                    batteryName={active ? `${active.brand} ${active.model}` : effRec ? `${effRec.brand} ${effRec.model}` : undefined}
                    monthlyKWh={monthlyKWh}
                    hasEv={hasEv}
                    hasExistingSolar={hasExistingSolar}
                  />
                )}

                {/* ───────── Why this battery ───────── */}
                {s.key === "whybattery" && active && (
                  <>
                    <PhotoBackdrop src={PHOTO.energy} active={isOn} position="center" />
                    <div
                      className={"sps-inner sps-rise" + (isOn ? " in" : "")}
                      style={{ ["--accent" as string]: brandAccent }}
                    >
                      <div className="sps-eyebrow sps-light">Why this battery</div>
                      <h2 className="sps-h2">{active.brand} {active.model}</h2>

                      <BatterySelector
                        options={options || []}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                      />

                      <div className="sps-glassTagline">{active.tagline}</div>

                      <div className="sps-crm">
                        <div className="sps-glass sps-crm-col">
                          <div className="sps-crm-h">Features</div>
                          <ul className="sps-crm-list">
                            {active.features.map((f, i) => (
                              <li key={i}>
                                <span className="sps-crm-check" style={{ color: brandAccent }}>✦</span>
                                {f}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className="sps-glass sps-crm-col">
                          <div className="sps-crm-h">What it means for you</div>
                          <ul className="sps-crm-list">
                            {active.benefits.map((b, i) => (
                              <li key={i}>
                                <span
                                  className="sps-crm-dot"
                                  style={{ background: brandAccent, boxShadow: `0 0 8px ${brandAccent}` }}
                                />
                                {b}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* ───────── See it in your space (3D / AR) ───────── */}
                {s.key === "battery3d" && active && (
                  <>
                    <PhotoBackdrop src={PHOTO.panels} active={isOn} dim position="center" />
                    <div
                      className={"sps-inner sps-rise" + (isOn ? " in" : "")}
                      style={{ ["--accent" as string]: brandAccent }}
                    >
                      <div className="sps-eyebrow sps-light">See it in your space</div>
                      <h2 className="sps-h2">Meet your {active.brand} {active.model}</h2>

                      <BatterySelector
                        options={options || []}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                      />

                      <div className="sps-3dwrap sps-glass" style={{ ["--accent" as string]: brandAccent }}>
                        {mvState === "failed" ? (
                          <BatteryFallback accent={brandAccent} label={`${active.brand} ${active.model}`} />
                        ) : (
                          <model-viewer
                            ref={mvRef as unknown as React.Ref<HTMLElement>}
                            src={GLB}
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
                        Spin it, zoom in, or place it on your wall in AR — this is the unit we&rsquo;d install.
                      </p>
                    </div>
                  </>
                )}

                {/* ───────── Your savings ───────── */}
                {s.key === "savings" && effRoi && (
                  <>
                    <PhotoBackdrop src={PHOTO.panels} active={isOn} dim position="center" />
                    <div
                      className={"sps-inner sps-rise" + (isOn ? " in" : "")}
                      style={{ ["--accent" as string]: brandAccent }}
                    >
                      <div className="sps-eyebrow sps-light">The numbers</div>
                      <h2 className="sps-h2">Your savings</h2>
                      {hasOptions && active && (
                        <div className="sps-activePill" style={{ borderColor: brandAccent }}>
                          <span className="sps-activePill-dot" style={{ background: brandAccent, boxShadow: `0 0 8px ${brandAccent}` }} />
                          {active.units}× {active.brand} {active.model}
                        </div>
                      )}
                      <div className="sps-glass sps-bignum">
                        <div className="sps-bignum-label">Net cost after incentives</div>
                        <div className="sps-bignum-value">{money0(netUp)}</div>
                        <div className="sps-bignum-eq">
                          {money0(effRoi.grossCost)} gross − {money0(effRoi.incentives)} incentives ={" "}
                          <strong>{money0(effRoi.netCost)}</strong>
                        </div>
                      </div>
                      <div className="sps-savegrid">
                        <div className="sps-glass sps-savecard">
                          <div className="sps-saveval">
                            <span className="sps-save-dot" style={{ background: PALETTE.solar, boxShadow: `0 0 8px ${PALETTE.solar}` }} />
                            {money0(moUp)}
                          </div>
                          <div className="sps-savelabel">Estimated monthly savings</div>
                        </div>
                        <div className="sps-glass sps-savecard">
                          <div className="sps-saveval">
                            <span className="sps-save-dot" style={{ background: PALETTE.export, boxShadow: `0 0 8px ${PALETTE.export}` }} />
                            {money0(lifeUp)}
                          </div>
                          <div className="sps-savelabel">Lifetime savings</div>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* ───────── Resilience / backup ───────── */}
                {s.key === "backup" && effRec && (
                  <>
                    <PhotoBackdrop src={PHOTO.night} active={isOn} position="center" />
                    <div
                      className={"sps-inner sps-rise" + (isOn ? " in" : "")}
                      style={{ ["--accent" as string]: brandAccent }}
                    >
                      <div className="sps-eyebrow sps-light">Resilience</div>
                      <h2 className="sps-h2">When the grid goes dark,<br />your lights stay on.</h2>
                      <div className="sps-glass sps-syscard" style={{ ["--accent" as string]: brandAccent }}>
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
                          No spoiled food, no cold showers, no scrambling for a generator. Your home
                          simply keeps running.
                        </p>
                      </div>
                    </div>
                  </>
                )}

                {/* ───────── Incentives ───────── */}
                {s.key === "incentives" && incentives && incentives.length > 0 && (
                  <>
                    <PhotoBackdrop src={PHOTO.solar} active={isOn} dim position="center" />
                    <div className={"sps-inner sps-rise" + (isOn ? " in" : "")}>
                      <div className="sps-eyebrow sps-light">Money back</div>
                      <h2 className="sps-h2">Your incentives</h2>
                      <p className="sps-sub">Verified from official sources.</p>
                      <div className="sps-inclist">
                        {incentives.map((inc, i) => (
                          <div className="sps-glass sps-inccard" key={i} style={{ animationDelay: `${0.06 * i}s` }}>
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
                  </>
                )}

                {/* ───────── Compare ───────── */}
                {s.key === "compare" && options && options.length >= 2 && (
                  <>
                    <PhotoBackdrop src={PHOTO.energy} active={isOn} dim position="center" />
                    <div className={"sps-inner sps-rise" + (isOn ? " in" : "")}>
                      <div className="sps-eyebrow sps-light">Side by side</div>
                      <h2 className="sps-h2">Compare two batteries</h2>
                      <CompareSlide
                        options={options}
                        compareIds={compareIds}
                        setCompareIds={setCompareIds}
                      />
                    </div>
                  </>
                )}

                {/* ───────── CTA ───────── */}
                {s.key === "cta" && (
                  <>
                    <PhotoBackdrop src={coverPhoto} active={isOn} position="center" />
                    <div className={"sps-inner sps-cta" + (isOn ? " in" : "")}>
                      <div className="sps-eyebrow sps-light">Next step</div>
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
                  </>
                )}
              </section>
            );
          })}
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
    <div className="sps-glass sps-cmp" style={{ ["--a-accent" as string]: a.accent, ["--b-accent" as string]: b.accent }}>
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
  --bg:#080512;--card:rgba(20,14,32,0.42);
  --line:rgba(255,255,255,0.12);--line-2:rgba(255,255,255,0.2);
  --text:#f4f1fb;--text-dim:#b6aecb;
  --accent:#8b5cf6;--accent-bright:#a78bfa;--accent-deep:#6d28d9;
  --solar:#ffd86b;--battery:#8b5cf6;--grid:#fbbf24;--export:#38bdf8;--ev:#f472b6;
  --font-head:'Space Grotesk',system-ui,-apple-system,sans-serif;
  --font-mono:'JetBrains Mono','SF Mono',Consolas,monospace;
  --font-body:'Inter',system-ui,-apple-system,sans-serif;
  position:fixed;inset:0;z-index:5000;color:var(--text);
  font-family:var(--font-body);
  background:#080512;
  overflow:hidden;display:flex;flex-direction:column;
  -webkit-font-smoothing:antialiased;}

/* atmosphere: film grain + vignette over everything */
.sps-grain{position:absolute;inset:0;pointer-events:none;z-index:30;
  opacity:.04;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
.sps-vignette{position:absolute;inset:0;pointer-events:none;z-index:29;
  box-shadow:inset 0 0 200px 50px rgba(0,0,0,0.6);}

.sps-close{position:absolute;top:max(14px,env(safe-area-inset-top));right:16px;z-index:40;
  width:42px;height:42px;border-radius:50%;border:1px solid var(--line-2);
  background:rgba(8,5,18,.45);color:var(--text);font-size:18px;cursor:pointer;
  backdrop-filter:blur(10px);transition:background .2s,border-color .2s,transform .1s;}
.sps-close:hover{background:rgba(139,92,246,.3);border-color:var(--accent);}
.sps-close:active{transform:scale(.94);}

.sps-stage{flex:1;min-height:0;overflow:hidden;position:relative;z-index:3;}
.sps-track{display:flex;height:100%;width:100%;
  transition:transform .6s cubic-bezier(.22,1,.36,1);}
.sps-slide{flex:0 0 100%;width:100%;height:100%;overflow:hidden;position:relative;
  display:flex;align-items:flex-end;justify-content:center;}

/* ── Full-bleed photographic backdrop ── */
.sps-bg{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;
  background:linear-gradient(165deg,#0c0820 0%,#0a0716 60%,#080512 100%);}
.sps-bg-img{position:absolute;inset:-6%;background-size:cover;background-position:center;
  transform:scale(1.02);transform-origin:center;animation:sps-fadein .9s ease;}
.sps-bg-img.kb{animation:sps-fadein .9s ease, sps-kenburns 26s ease-out forwards;}
@keyframes sps-kenburns{from{transform:scale(1.02);}to{transform:scale(1.16) translate(1.5%,-1.5%);}}
@keyframes sps-fadein{from{opacity:0;}to{opacity:1;}}
.sps-bg-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
.sps-bg-scrim{position:absolute;inset:0;
  background:
    linear-gradient(180deg,rgba(8,5,18,.2) 0%,rgba(8,5,18,.42) 42%,rgba(8,5,18,.85) 100%),
    radial-gradient(130% 80% at 80% -10%,rgba(139,92,246,.18),transparent 60%);}
.sps-bg-scrim.dim{
  background:
    linear-gradient(180deg,rgba(8,5,18,.5) 0%,rgba(8,5,18,.66) 42%,rgba(6,4,14,.93) 100%),
    radial-gradient(130% 80% at 80% -10%,rgba(139,92,246,.16),transparent 60%);}

/* slide content sits above the photo, anchored low with breathing room */
.sps-inner{position:relative;z-index:5;width:100%;max-width:980px;
  display:flex;flex-direction:column;align-items:center;text-align:center;
  gap:clamp(13px,2.2vh,22px);
  padding:clamp(20px,5vw,56px) clamp(18px,4vw,48px) clamp(64px,9vh,96px);
  max-height:100%;overflow-y:auto;}

/* glassmorphism card primitive */
.sps-glass{background:rgba(18,12,30,0.46);border:1px solid var(--line);
  border-radius:18px;backdrop-filter:blur(18px) saturate(1.2);
  -webkit-backdrop-filter:blur(18px) saturate(1.2);
  box-shadow:0 24px 70px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.07);}

/* staggered entrance */
.sps-rise>*{opacity:0;transform:translateY(18px);}
.sps-rise.in>*{animation:sps-rise .75s cubic-bezier(.22,1,.36,1) forwards;}
.sps-rise.in>*:nth-child(1){animation-delay:.05s;}
.sps-rise.in>*:nth-child(2){animation-delay:.12s;}
.sps-rise.in>*:nth-child(3){animation-delay:.19s;}
.sps-rise.in>*:nth-child(4){animation-delay:.26s;}
.sps-rise.in>*:nth-child(5){animation-delay:.33s;}
.sps-rise.in>*:nth-child(6){animation-delay:.40s;}
@keyframes sps-rise{to{opacity:1;transform:none;}}

/* typography */
.sps-eyebrow{font-family:var(--font-mono);font-size:11px;letter-spacing:.25em;
  text-transform:uppercase;color:var(--text-dim);font-weight:500;}
.sps-eyebrow::before{content:'·';margin-right:9px;color:var(--accent-bright);}
.sps-eyebrow.sps-light{color:#d8d1ea;}
.sps-h2{font-family:var(--font-head);
  font-size:clamp(30px,6vw,60px);font-weight:700;letter-spacing:-.025em;line-height:1.04;
  color:#fff;margin:0;text-shadow:0 2px 30px rgba(0,0,0,.5);}
.sps-sub{color:#d8d1ea;font-size:14px;margin:-4px 0 0;text-shadow:0 1px 12px rgba(0,0,0,.6);}
.sps-tag{font-family:var(--font-mono);font-size:10px;letter-spacing:.22em;
  text-transform:uppercase;color:var(--text-dim);margin-bottom:8px;}

/* ── 1. Cover ── */
.sps-cover{justify-content:flex-end;align-items:flex-start;text-align:left;
  padding-bottom:clamp(70px,12vh,120px);}
.sps-cover>*{opacity:0;transform:translateY(22px);}
.sps-cover.in>*{animation:sps-rise .9s cubic-bezier(.22,1,.36,1) forwards;}
.sps-cover.in>*:nth-child(1){animation-delay:.15s;}
.sps-cover.in>*:nth-child(2){animation-delay:.32s;}
.sps-cover.in>*:nth-child(3){animation-delay:.5s;}
.sps-cover.in>*:nth-child(4){animation-delay:.62s;}
.sps-cover.in>*:nth-child(5){animation-delay:.72s;}
.sps-cover.in>*:nth-child(6){animation-delay:.82s;}
.sps-title{font-family:var(--font-head);
  font-size:clamp(40px,11vw,96px);font-weight:700;line-height:.98;letter-spacing:-.035em;
  color:#fff;margin:10px 0 0;text-shadow:0 4px 50px rgba(0,0,0,.6);}
.sps-coverName{font-family:var(--font-head);font-size:clamp(20px,4vw,30px);font-weight:600;
  margin-top:18px;text-shadow:0 2px 20px rgba(0,0,0,.6);}
.sps-coverAddr{font-family:var(--font-mono);color:#cfc7e2;font-size:12.5px;letter-spacing:.06em;
  margin-top:7px;text-shadow:0 1px 12px rgba(0,0,0,.7);}
.sps-coverTag{display:inline-block;font-family:var(--font-mono);font-size:9.5px;
  letter-spacing:.22em;text-transform:uppercase;color:var(--accent-bright);font-weight:600;
  padding:5px 12px;border-radius:999px;margin-top:16px;
  background:rgba(8,5,18,.5);border:1px solid var(--line-2);backdrop-filter:blur(8px);}
.sps-scrollHint{font-family:var(--font-mono);font-size:10px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--text-dim);margin-top:26px;
  animation:sps-driftx 2.4s ease-in-out infinite;}
@keyframes sps-driftx{0%,100%{transform:translateX(0);opacity:.6;}50%{transform:translateX(6px);opacity:1;}}

/* ── 2. Interactive scene ── */
.sps-scene-inner{justify-content:flex-end;gap:clamp(11px,1.8vh,18px);}
.sps-scene-inner>*{opacity:0;transform:translateY(16px);}
.sps-scene-inner.in>*{animation:sps-rise .7s cubic-bezier(.22,1,.36,1) forwards;}
.sps-scene-inner.in>*:nth-child(1){animation-delay:.05s;}
.sps-scene-inner.in>*:nth-child(2){animation-delay:.1s;}
.sps-scene-inner.in>*:nth-child(3){animation-delay:.15s;}
.sps-scene-inner.in>*:nth-child(4){animation-delay:.2s;}
.sps-scene-inner.in>*:nth-child(5){animation-delay:.25s;}
.sps-scene-inner.in>*:nth-child(6){animation-delay:.3s;}

/* ── illustrated energy scene (self-contained vector diagram) ── */
.sps-scene2{position:absolute;inset:0;z-index:1;width:100%;height:100%;pointer-events:none;}
.sps-scene-scrim{position:absolute;inset:0;z-index:2;pointer-events:none;
  background:linear-gradient(180deg,rgba(8,5,18,0) 36%,rgba(8,5,18,.5) 70%,rgba(6,4,14,.92) 100%);}
.sps-scene2 .sps-skyfade{transition:opacity .9s ease;}
.sps-stars{transition:opacity .9s ease;}
.sps-star{animation:sps-twinkle 3.4s ease-in-out infinite;}
@keyframes sps-twinkle{0%,100%{opacity:.2;}50%{opacity:.95;}}
.sps-sunglow{animation:sps-hubpulse 5s ease-in-out infinite;transform-origin:180px 120px;}
.sps-hub2{animation:sps-hubpulse 4s ease-in-out infinite;transform-origin:560px 392px;}
@keyframes sps-hubpulse{0%,100%{opacity:.55;}50%{opacity:1;}}
.sps-roof2{transition:filter .5s ease;}
.sps-roof2.live{filter:drop-shadow(0 0 12px rgba(255,216,107,.55));}
.sps-win{fill:#0c0a18;stroke:rgba(255,255,255,.08);transition:fill .6s ease;}
.sps-win.lit{fill:#ffd98a;filter:drop-shadow(0 0 9px rgba(255,210,120,.7));}
.sps-grid2{transition:opacity .5s ease;}
.sps-grid2.off{opacity:.32;}
.sps-bat2-fill{transition:y .6s ease,height .6s ease,opacity .4s ease;}
.sps-tag2{transition:opacity .4s ease;}
.sps-tag2-bg{fill:rgba(8,5,18,.66);stroke:rgba(255,255,255,.16);stroke-width:1;}
.sps-tag2-l{font-family:var(--font-mono);font-size:9px;letter-spacing:.16em;fill:#cfc7e2;font-weight:600;}
.sps-tag2-v{font-family:var(--font-mono);font-size:12px;font-weight:700;letter-spacing:.01em;}
.sps-live2-dot{animation:sps-pulse 1.6s ease-in-out infinite;}
.sps-flow{fill:none;stroke-width:3;stroke-linecap:round;opacity:0;
  stroke-dasharray:8 13;transition:opacity .5s;}
.sps-flow.on{opacity:.95;animation:sps-flowDash 1.4s linear infinite;}
.sps-flow.rev.on{animation-direction:reverse;}
@keyframes sps-flowDash{to{stroke-dashoffset:-42;}}

.sps-outageBadge{position:absolute;top:max(64px,calc(env(safe-area-inset-top) + 50px));
  left:50%;transform:translateX(-50%);z-index:8;
  font-family:var(--font-mono);font-size:10px;letter-spacing:.18em;font-weight:600;
  color:#fbbf24;padding:7px 14px;border-radius:999px;
  background:rgba(8,5,18,.62);border:1px solid rgba(251,191,36,.45);
  backdrop-filter:blur(10px);box-shadow:0 0 24px rgba(251,191,36,.25);
  animation:sps-blink 1.6s ease-in-out infinite;white-space:nowrap;}
@keyframes sps-blink{50%{opacity:.55;}}

.sps-switcher{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}
.sps-scbtn{display:flex;align-items:center;gap:9px;font-family:var(--font-head);
  padding:10px 14px;min-width:124px;border-radius:12px;border:1px solid var(--line-2);
  background:rgba(8,5,18,.42);color:var(--text);cursor:pointer;backdrop-filter:blur(10px);
  text-align:left;line-height:1.15;transition:all .2s ease;min-height:48px;}
.sps-scbtn-ico{font-size:15px;opacity:.7;flex-shrink:0;}
.sps-scbtn-txt{display:flex;flex-direction:column;gap:2px;}
.sps-scbtn-label{font-size:12.5px;font-weight:600;}
.sps-scbtn-sub{font-family:var(--font-mono);font-size:8.5px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--text-dim);}
.sps-scbtn:hover{border-color:rgba(255,255,255,.34);background:rgba(8,5,18,.55);}
.sps-scbtn.on{background:rgba(139,92,246,.22);border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(139,92,246,.2),0 0 22px rgba(139,92,246,.3);}
.sps-scbtn.on .sps-scbtn-ico{opacity:1;color:var(--accent-bright);}
.sps-scbtn.on .sps-scbtn-sub{color:var(--accent-bright);}

@keyframes sps-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}

.sps-daynight{display:inline-flex;gap:5px;background:rgba(8,5,18,.55);border:1px solid var(--line-2);
  border-radius:999px;padding:4px;backdrop-filter:blur(10px);align-self:center;}
.sps-dnbtn{font-family:var(--font-mono);font-size:11px;font-weight:500;letter-spacing:.05em;
  padding:6px 15px;border-radius:999px;border:0;background:transparent;color:var(--text-dim);
  cursor:pointer;transition:all .2s;}
.sps-dnbtn.on{background:rgba(139,92,246,.3);color:#fff;box-shadow:0 0 0 1px var(--accent);}

.sps-legend{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;
  font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--text-dim);}
.sps-legend span{display:inline-flex;align-items:center;gap:6px;}
.sps-legend i{width:9px;height:9px;border-radius:3px;display:inline-block;}

.sps-caption{font-family:var(--font-body);font-size:clamp(15px,2.4vw,19px);line-height:1.5;
  color:#e6e0f2;max-width:660px;margin:0;animation:sps-fade .5s ease;
  text-shadow:0 1px 14px rgba(0,0,0,.7);}
@keyframes sps-fade{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}

.sps-batfb-charge{animation:sps-fbpulse 2.4s ease-in-out infinite;transform-origin:center bottom;}
@keyframes sps-fbpulse{0%,100%{opacity:.65;}50%{opacity:1;}}

/* ── Savings ── */
.sps-bignum{position:relative;overflow:hidden;
  padding:clamp(22px,4vw,40px);width:min(620px,94vw);}
.sps-bignum::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
  background:var(--accent);box-shadow:0 0 14px var(--accent);}
.sps-bignum-label{font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
  text-transform:uppercase;letter-spacing:.22em;}
.sps-bignum-value{font-family:var(--font-head);
  font-size:clamp(48px,12vw,92px);font-weight:700;line-height:1;margin:10px 0;letter-spacing:-.025em;
  background:linear-gradient(135deg,#fff,var(--accent-bright));
  -webkit-background-clip:text;background-clip:text;color:transparent;}
.sps-bignum-eq{font-family:var(--font-mono);font-size:11.5px;letter-spacing:.02em;color:var(--text-dim);}
.sps-bignum-eq strong{color:var(--text);font-weight:600;}
.sps-savegrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;width:min(620px,94vw);}
.sps-savecard{position:relative;overflow:hidden;padding:22px 16px;text-align:center;}
.sps-saveval{display:flex;align-items:center;justify-content:center;gap:9px;
  font-family:var(--font-head);font-size:clamp(26px,6vw,40px);font-weight:700;line-height:1;}
.sps-save-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
.sps-savelabel{font-family:var(--font-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--text-dim);margin-top:10px;}
@media(max-width:520px){.sps-savegrid{grid-template-columns:1fr;}}

/* ── Backup / resilience ── */
.sps-syscard{position:relative;overflow:hidden;text-align:left;width:min(560px,94vw);padding:24px;}
.sps-syscard::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
  background:var(--accent);box-shadow:0 0 14px var(--accent);}
.sps-sysname{font-family:var(--font-head);font-size:22px;font-weight:600;letter-spacing:-.02em;}
.sps-sysstats{display:flex;gap:26px;margin:18px 0;flex-wrap:wrap;}
.sps-sysn{font-family:var(--font-mono);font-size:32px;font-weight:700;
  color:var(--accent-bright);line-height:1;}
.sps-sysl{font-family:var(--font-mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--text-dim);margin-top:6px;}
.sps-syslead{font-family:var(--font-body);font-size:14px;line-height:1.55;color:#d8d1ea;margin:0;}

/* ── Incentives ── */
.sps-inclist{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
  gap:14px;width:min(900px,96vw);
  max-height:min(58vh,540px);overflow-y:auto;padding:2px;align-content:start;
  align-items:start;justify-items:stretch;}
.sps-inccard{position:relative;overflow:hidden;display:flex;flex-direction:column;
  align-items:flex-start;min-width:0;padding:18px 18px 18px 20px;text-align:left;
  animation:sps-rise .6s cubic-bezier(.22,1,.36,1) backwards;}
.sps-inccard::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
  background:var(--solar);box-shadow:0 0 12px var(--solar);}
.sps-inccard:hover{border-color:var(--line-2);transform:translateY(-2px);transition:transform .25s;}
.sps-incName{font-family:var(--font-head);font-weight:600;font-size:15px;letter-spacing:-.01em;
  line-height:1.3;max-width:100%;overflow-wrap:anywhere;word-break:break-word;}
.sps-incAmt{display:inline-block;max-width:100%;margin-top:10px;
  font-family:var(--font-mono);background:rgba(255,216,107,.16);
  color:var(--solar);font-weight:600;font-size:11px;line-height:1.4;padding:4px 10px;border-radius:8px;
  white-space:normal;overflow-wrap:anywhere;word-break:break-word;
  border:1px solid rgba(255,216,107,.34);}
.sps-incMeta{font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;color:var(--text-dim);
  margin-top:10px;max-width:100%;overflow-wrap:anywhere;word-break:break-word;}
.sps-incLink{display:inline-block;margin-top:12px;font-family:var(--font-mono);font-size:11px;
  letter-spacing:.05em;color:var(--accent-bright);font-weight:500;}

/* ── CTA ── */
.sps-cta{justify-content:center;align-items:center;text-align:center;
  padding-bottom:clamp(70px,12vh,120px);}
.sps-cta>*{opacity:0;transform:translateY(20px);}
.sps-cta.in>*{animation:sps-rise .85s cubic-bezier(.22,1,.36,1) forwards;}
.sps-cta.in>*:nth-child(1){animation-delay:.12s;}
.sps-cta.in>*:nth-child(2){animation-delay:.28s;}
.sps-cta.in>*:nth-child(3){animation-delay:.44s;}
.sps-cta.in>*:nth-child(4){animation-delay:.56s;}
.sps-cta.in>*:nth-child(5){animation-delay:.66s;}
.sps-ctaTitle{font-family:var(--font-head);
  font-size:clamp(36px,8vw,80px);font-weight:700;letter-spacing:-.035em;line-height:1;
  color:#fff;margin:0;text-shadow:0 4px 50px rgba(0,0,0,.6);}
.sps-ctaSub{font-family:var(--font-body);font-size:clamp(16px,3vw,22px);
  color:#e6e0f2;max-width:580px;margin:6px 0 0;text-shadow:0 1px 16px rgba(0,0,0,.7);}
.sps-ctaLine{font-family:var(--font-mono);font-size:13px;letter-spacing:.03em;
  color:var(--accent-bright);margin:0;font-weight:500;}
.sps-ctaCompany{margin-top:22px;font-family:var(--font-mono);font-size:11px;
  letter-spacing:.22em;text-transform:uppercase;color:var(--text-dim);font-weight:500;}

/* ── Nav controls ── */
.sps-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:25;
  width:48px;height:48px;border-radius:50%;border:1px solid var(--line-2);
  background:rgba(8,5,18,.45);color:var(--text);font-size:26px;line-height:1;cursor:pointer;
  backdrop-filter:blur(10px);transition:background .2s,border-color .2s,transform .1s;
  display:flex;align-items:center;justify-content:center;}
.sps-nav:hover:not(:disabled){background:rgba(139,92,246,.3);border-color:var(--accent);}
.sps-nav:active:not(:disabled){transform:translateY(-50%) scale(.92);}
.sps-nav:disabled{opacity:.2;cursor:default;}
.sps-nav.prev{left:14px;}
.sps-nav.next{right:14px;}

.sps-dots{position:absolute;bottom:max(18px,env(safe-area-inset-bottom));left:50%;
  transform:translateX(-50%);z-index:25;display:flex;gap:10px;}
.sps-dot{width:9px;height:9px;border-radius:50%;border:0;cursor:pointer;
  background:rgba(255,255,255,.28);transition:all .25s;padding:0;}
.sps-dot.on{background:var(--accent-bright);width:26px;border-radius:999px;
  box-shadow:0 0 14px rgba(139,92,246,.8);}

@media(max-width:560px){
  .sps-nav{width:40px;height:40px;font-size:22px;}
  .sps-nav.prev{left:8px;}
  .sps-nav.next{right:8px;}
  .sps-scbtn{min-width:calc(50% - 4px);flex:1 1 calc(50% - 4px);}
}

/* ── CRM: battery selector ── */
.sps-batsel{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;width:min(940px,96vw);}
.sps-batsel-item{position:relative;display:flex;align-items:center;gap:10px;
  padding:9px 13px;border-radius:12px;border:1px solid var(--line-2);
  background:rgba(8,5,18,.42);color:var(--text);cursor:pointer;text-align:left;
  backdrop-filter:blur(10px);
  transition:border-color .2s,background .2s,box-shadow .2s,transform .1s;min-height:48px;}
.sps-batsel-item:hover{background:rgba(8,5,18,.6);}
.sps-batsel-item:active{transform:scale(.98);}
.sps-batsel-item.on{background:rgba(139,92,246,.16);}
.sps-batsel-swatch{width:14px;height:22px;border-radius:4px;flex-shrink:0;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.22);}
.sps-batsel-txt{display:flex;flex-direction:column;gap:2px;}
.sps-batsel-name{font-family:var(--font-head);font-size:13px;font-weight:600;line-height:1.1;}
.sps-batsel-kwh{font-family:var(--font-mono);font-size:9px;letter-spacing:.08em;color:var(--text-dim);}
.sps-batsel-badge{font-family:var(--font-mono);font-size:8px;letter-spacing:.1em;font-weight:600;
  color:#06121f;background:linear-gradient(135deg,#ffe9a8,var(--solar));
  padding:3px 7px;border-radius:999px;margin-left:2px;white-space:nowrap;}

/* ── CRM: interactive 3D / AR ── */
.sps-3dwrap{position:relative;width:min(560px,94vw);aspect-ratio:4/5;max-height:56vh;
  overflow:hidden;}
.sps-3dwrap::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
  background:var(--accent);z-index:4;border-radius:3px 0 0 3px;box-shadow:0 0 14px var(--accent);}
.sps-3dwrap model-viewer{width:100%;height:100%;display:block;}
.sps-3dover{position:absolute;left:0;right:0;top:0;z-index:3;padding:14px 16px;
  display:flex;flex-direction:column;gap:6px;pointer-events:none;
  background:linear-gradient(180deg,rgba(8,5,18,.6),transparent);}
.sps-3dname{font-family:var(--font-head);font-size:clamp(15px,2.6vw,20px);font-weight:600;
  text-align:left;letter-spacing:-.01em;}
.sps-3dspecs{display:flex;flex-wrap:wrap;gap:6px 14px;font-family:var(--font-mono);
  font-size:10.5px;letter-spacing:.04em;color:var(--text-dim);}
.sps-3dspecs b{color:var(--accent-bright);font-weight:700;font-size:13px;}
.sps-arbtn{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:5;
  font-family:var(--font-head);font-size:13px;font-weight:600;letter-spacing:.01em;
  padding:11px 18px;border-radius:999px;border:1px solid var(--accent);color:#fff;cursor:pointer;
  background:rgba(8,5,18,.72);backdrop-filter:blur(10px);transition:background .2s,transform .1s;
  white-space:nowrap;}
.sps-arbtn:hover{background:rgba(139,92,246,.35);}
.sps-arbtn:active{transform:translateX(-50%) scale(.96);}
.sps-3dnote{position:absolute;left:0;right:0;bottom:60px;z-index:5;text-align:center;
  font-family:var(--font-mono);font-size:10px;letter-spacing:.06em;color:var(--text-dim);}
/* CSS/SVG fallback battery */
.sps-batfb{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:12px;padding:20px;}
.sps-batfb-svg{width:auto;height:62%;max-width:60%;
  filter:drop-shadow(0 12px 30px rgba(0,0,0,.5));}
.sps-batfb-label{font-family:var(--font-head);font-size:15px;font-weight:600;}

/* ── CRM: features & benefits ── */
.sps-activePill{display:inline-flex;align-items:center;gap:8px;align-self:center;
  font-family:var(--font-mono);font-size:11px;letter-spacing:.06em;
  padding:6px 13px;border-radius:999px;border:1px solid var(--line-2);
  background:rgba(8,5,18,.5);backdrop-filter:blur(8px);}
.sps-activePill-dot{width:8px;height:8px;border-radius:50%;}
.sps-glassTagline{font-family:var(--font-head);font-size:clamp(16px,3vw,22px);font-weight:600;
  line-height:1.35;max-width:680px;color:#fff;text-shadow:0 2px 18px rgba(0,0,0,.6);}
.sps-crm{display:grid;grid-template-columns:1fr 1fr;gap:16px;width:min(900px,96vw);text-align:left;}
.sps-crm-col{position:relative;overflow:hidden;padding:20px 22px;}
.sps-crm-col::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
  background:var(--accent);box-shadow:0 0 12px var(--accent);}
.sps-crm-h{font-family:var(--font-mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--text-dim);margin-bottom:12px;}
.sps-crm-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;}
.sps-crm-list li{display:flex;align-items:flex-start;gap:10px;font-family:var(--font-body);
  font-size:14px;line-height:1.45;color:#e6e0f2;}
.sps-crm-check{flex-shrink:0;font-size:13px;line-height:1.4;}
.sps-crm-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:6px;}
@media(max-width:680px){.sps-crm{grid-template-columns:1fr;}}

/* ── CRM: compare two ── */
.sps-cmp{width:min(900px,96vw);overflow:hidden;}
.sps-cmp-heads,.sps-cmp-row{display:grid;grid-template-columns:1.2fr 1fr 1fr;}
.sps-cmp-heads{padding:14px 12px;border-bottom:1px solid var(--line);gap:8px;align-items:start;}
.sps-cmp-spacer{}
.sps-cmp-head{display:flex;flex-direction:column;align-items:center;gap:7px;text-align:center;}
.sps-cmp-swatch{width:26px;height:8px;border-radius:4px;}
.sps-cmp-pick{width:100%;max-width:170px;font-family:var(--font-head);font-size:12.5px;font-weight:600;
  padding:7px 9px;border-radius:9px;border:1px solid var(--line-2);
  background:rgba(8,5,18,.6);color:var(--text);cursor:pointer;}
.sps-cmp-badge{font-family:var(--font-mono);font-size:8px;letter-spacing:.1em;font-weight:600;
  color:#06121f;background:linear-gradient(135deg,#ffe9a8,var(--solar));
  padding:3px 7px;border-radius:999px;}
.sps-cmp-rows{display:flex;flex-direction:column;}
.sps-cmp-row{padding:11px 12px;gap:8px;align-items:center;border-bottom:1px solid var(--line);}
.sps-cmp-row:last-child{border-bottom:0;}
.sps-cmp-row:nth-child(even){background:rgba(255,255,255,.03);}
.sps-cmp-label{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--text-dim);}
.sps-cmp-val{font-family:var(--font-head);font-size:14px;font-weight:600;text-align:center;
  color:#e6e0f2;}
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
  .sps-bg-img,.sps-bg-img.kb{animation:none!important;transform:scale(1.04)!important;}
  .sps-batfb-charge{animation:none!important;opacity:.9;}
  .sps-flow.on,.sps-flow.rev.on{animation:none!important;opacity:.95;}
  .sps-sunglow,.sps-hub2,.sps-star,.sps-live2-dot,.sps-grain,.sps-outageBadge,.sps-scrollHint{animation:none!important;}
  .sps-track{transition:none;}
  .sps-rise>*,.sps-cover>*,.sps-cta>*,.sps-scene-inner>*,.sps-inccard{
    opacity:1!important;transform:none!important;animation:none!important;}
}
`;
