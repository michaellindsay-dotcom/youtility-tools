import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { functions, storage } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { batteryContent } from "../lib/batteries";

const MV_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const AR_GLB = `${MV_BASE}/battery.glb`;
const AR_USDZ = `${MV_BASE}/battery.usdz`;
function hexRgb01(hex: string): [number, number, number, number] {
  let h = (hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [0.545, 0.361, 0.965, 1];
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1];
}

// "See it in your space" AR for the ONE sold battery — used at the start of the
// site survey so the rep can place it and photograph the spot.
function BatteryAR({ accent }: { accent: string }) {
  const ref = useRef<any>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const w = window as any;
    if (w.customElements?.get?.("model-viewer")) { setState("ready"); return; }
    if (!w.__spsMvInjected) {
      w.__spsMvInjected = true;
      const el = document.createElement("script");
      el.type = "module";
      el.src = "https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js";
      el.onerror = () => setState("failed");
      document.head.appendChild(el);
    }
    let tries = 0;
    const poll = window.setInterval(() => {
      if (w.customElements?.get?.("model-viewer")) { setState("ready"); window.clearInterval(poll); }
      else if (++tries > 25) { setState("failed"); window.clearInterval(poll); }
    }, 200);
    return () => window.clearInterval(poll);
  }, []);

  useEffect(() => {
    if (state !== "ready") return;
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      try { el.model?.materials?.[0]?.pbrMetallicRoughness?.setBaseColorFactor?.(hexRgb01(accent)); } catch { /* not ready */ }
    };
    apply();
    el.addEventListener("load", apply);
    return () => el.removeEventListener("load", apply);
  }, [state, accent]);

  if (state === "failed") return null;
  return createElement("model-viewer", {
    ref,
    src: AR_GLB,
    "ios-src": AR_USDZ,
    "camera-controls": true,
    "auto-rotate": true,
    ar: true,
    "ar-modes": "webxr scene-viewer quick-look",
    "shadow-intensity": "1",
    exposure: "1",
    "touch-action": "pan-y",
    style: { width: "100%", height: 220, background: "transparent", borderRadius: 10, display: "block" },
  });
}

// Sold-customer projects. Reps see their own deals as bullet summaries and run
// the placement + site-survey capture; admins/managers see everything. The full
// project-management portal (separate login) comes later — this is the capture +
// review handoff.

type ProjectItem = {
  id: string;
  customerName: string;
  address: string;
  battery: string;
  batteryProductId?: string;
  paymentMethod: string;
  reference: string;
  status: string;
  signedAt: number;
  submittedAt: number;
  // admin-only extras
  customerEmail?: string;
  payment?: any;
  survey?: { photos?: Record<string, string>; checklist?: Record<string, boolean> } | null;
  placement?: Array<{ url: string; note: string }>;
  surveyNotes?: string;
};

const SURVEY_PHOTOS: Array<{ key: string; label: string }> = [
  { key: "main_panel", label: "Main electrical panel (cover off)" },
  { key: "panel_label", label: "Panel label / breaker schedule" },
  { key: "meter", label: "Utility meter" },
  { key: "location", label: "Proposed battery location" },
  { key: "exterior", label: "Home exterior / address" },
  { key: "utility_bill", label: "Utility bill" },
];
const CHECKLIST: Array<{ key: string; label: string }> = [
  { key: "utility_bill", label: "Utility bill collected" },
  { key: "panel_space", label: "Panel has space / capacity" },
  { key: "location_clear", label: "Install location accessible & clear" },
  { key: "wifi", label: "Home Wi-Fi available for monitoring" },
  { key: "meter_number", label: "Meter number recorded" },
  { key: "address_verified", label: "Service address verified" },
];

const STATUS_LABEL: Record<string, { t: string; c: string }> = {
  needs_survey: { t: "Needs site survey", c: "#f59e0b" },
  survey_scheduled: { t: "Survey scheduled", c: "#38bdf8" },
  submitted_for_review: { t: "Submitted for review", c: "#34d399" },
};

const fmtDate = (ms: number) => (ms ? new Date(ms).toLocaleDateString() : "—");

export default function Projects() {
  const { company } = useAuth();
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [isMgr, setIsMgr] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [capture, setCapture] = useState<ProjectItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const { data } = await httpsCallable<unknown, { items: ProjectItem[]; isManager: boolean }>(functions, "listMyProjects")({});
      setItems(data.items || []);
      setIsMgr(!!data.isManager);
      // Auto-open the capture flow when the rep just signed and was routed here
      // with ?capture=<projectId>.
      const want = new URLSearchParams(window.location.search).get("capture");
      if (want) {
        const hit = (data.items || []).find((x) => x.id === want);
        if (hit) setCapture(hit);
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch (e) {
      setErr((e as Error).message || "Couldn't load projects.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page-body">
      <div className="page-head row">
        <h1>Sold Projects</h1>
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>
        {isMgr ? "Every signed deal in your company, with site-survey detail." : "Your signed deals. Capture the placement photos and site survey, then submit for review."}
      </p>

      {loading && <div className="empty">Loading…</div>}
      {err && <p className="muted small" style={{ color: "#ef4444" }}>{err}</p>}
      {!loading && !items.length && <div className="empty">No sold projects yet. Close a deal in the Battery Tool and it shows up here.</div>}

      <div style={{ display: "grid", gap: 12 }}>
        {items.map((p) => {
          const st = STATUS_LABEL[p.status] || STATUS_LABEL.needs_survey;
          return (
            <div className="card" key={p.id} style={{ padding: 16 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{p.customerName || "Customer"}</div>
                  <div className="muted small">{p.address}</div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: st.c, border: `1px solid ${st.c}`, borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap" }}>{st.t}</span>
              </div>

              {/* Bullet summary (everyone) */}
              <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6 }}>
                <li>System: <strong>{p.battery}</strong></li>
                <li>Payment: {p.paymentMethod === "finance" ? "Financed" : p.paymentMethod === "cash" ? "Cash" : "—"}</li>
                <li>Signed: {fmtDate(p.signedAt)}{p.reference ? ` · ref ${p.reference}` : ""}</li>
                {p.submittedAt ? <li>Survey submitted: {fmtDate(p.submittedAt)}</li> : null}
              </ul>

              {/* Admin/manager: full detail */}
              {isMgr && (
                <div style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10 }}>
                  {p.customerEmail && <div className="muted small">📧 {p.customerEmail}</div>}
                  {(p.placement?.length || 0) > 0 && (
                    <>
                      <div className="muted small" style={{ marginTop: 8, marginBottom: 4 }}>Placement photos</div>
                      <PhotoRow urls={(p.placement || []).map((x) => x.url)} notes={(p.placement || []).map((x) => x.note)} />
                    </>
                  )}
                  {p.survey?.photos && Object.keys(p.survey.photos).length > 0 && (
                    <>
                      <div className="muted small" style={{ marginTop: 8, marginBottom: 4 }}>Site-survey photos</div>
                      <PhotoRow urls={Object.values(p.survey.photos)} notes={Object.keys(p.survey.photos)} />
                    </>
                  )}
                  {p.survey?.checklist && (
                    <div style={{ marginTop: 8, fontSize: 12.5 }}>
                      {CHECKLIST.map((c) => (
                        <span key={c.key} style={{ marginRight: 12, color: p.survey?.checklist?.[c.key] ? "#34d399" : "#8a8199" }}>
                          {p.survey?.checklist?.[c.key] ? "✓" : "○"} {c.label}
                        </span>
                      ))}
                    </div>
                  )}
                  {p.surveyNotes && <p className="muted small" style={{ marginTop: 8 }}>“{p.surveyNotes}”</p>}
                </div>
              )}

              {/* Capture action — available to the rep and to admins/managers. */}
              <button className="btn primary sm" style={{ marginTop: 12 }} onClick={() => setCapture(p)}>
                {p.status === "submitted_for_review"
                  ? "↻ Update site survey"
                  : p.status === "survey_scheduled"
                  ? "📋 Site survey scheduled — open"
                  : "📸 Placement & site survey"}
              </button>
            </div>
          );
        })}
      </div>

      {capture && company && (
        <ProjectCapture
          project={capture}
          companyId={company.id}
          onClose={() => setCapture(null)}
          onDone={() => { setCapture(null); void load(); }}
        />
      )}
    </div>
  );
}

function PhotoRow({ urls, notes }: { urls: string[]; notes?: string[] }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {urls.map((u, i) => (
        <a key={i} href={u} target="_blank" rel="noreferrer" title={notes?.[i] || ""}>
          <img src={u} alt={notes?.[i] || "photo"} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)" }} />
        </a>
      ))}
    </div>
  );
}

type Shot = { file?: File; url?: string; note: string };

type Step = "placement" | "choice" | "survey" | "schedule";

function ProjectCapture({
  project,
  companyId,
  onClose,
  onDone,
}: {
  project: ProjectItem;
  companyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>("placement");
  const [placement, setPlacement] = useState<Shot[]>([]);
  const [photos, setPhotos] = useState<Record<string, File | undefined>>({});
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const placementInput = useRef<HTMLInputElement | null>(null);

  const addPlacementFiles = (files?: FileList | null) => {
    if (!files || !files.length) return;
    const arr = Array.from(files);
    setPlacement((p) => {
      const next = [...p];
      for (const f of arr) { if (next.length >= 3) break; next.push({ file: f, note: "" }); }
      return next;
    });
  };

  const upload = async (key: string, file: File): Promise<string> => {
    const safe = `${project.id}-${key}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
    const r = storageRef(storage, `projects/${companyId}/${safe}`);
    await uploadBytes(r, file, { contentType: file.type || "image/jpeg" });
    return getDownloadURL(r);
  };

  // Upload the placement photos once, cache the URLs on the shots, then advance.
  const goToChoice = async () => {
    if (placement.length < 2) { setErr("Take at least 2 placement photos first (max 3)."); return; }
    setBusy(true);
    setErr("");
    try {
      const out: Shot[] = [];
      for (let i = 0; i < placement.length; i++) {
        const s = placement[i];
        const url = s.url || (s.file ? await upload(`placement${i}`, s.file) : "");
        out.push({ ...s, url, file: undefined });
      }
      setPlacement(out);
      setStep("choice");
    } catch (e) {
      setErr((e as Error).message || "Couldn't upload the photos. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const placeOut = () => placement.filter((s) => s.url).map((s) => ({ url: s.url as string, note: s.note }));

  const submitNow = async () => {
    setBusy(true); setErr("");
    try {
      const photoOut: Record<string, string> = {};
      for (const slot of SURVEY_PHOTOS) { const f = photos[slot.key]; if (f) photoOut[slot.key] = await upload(slot.key, f); }
      await httpsCallable<unknown, { ok?: boolean }>(functions, "submitProjectSurvey")({
        projectId: project.id, placement: placeOut(), survey: { photos: photoOut, checklist }, notes,
      });
      onDone();
    } catch (e) { setErr((e as Error).message || "Couldn't submit. Try again."); } finally { setBusy(false); }
  };

  const doSchedule = async () => {
    const startAt = when ? new Date(when).getTime() : 0;
    if (!startAt) { setErr("Pick a date and time for the survey."); return; }
    setBusy(true); setErr("");
    try {
      await httpsCallable<unknown, { ok?: boolean }>(functions, "scheduleSiteSurvey")({
        projectId: project.id, startAt, placement: placeOut(), notes,
      });
      onDone();
    } catch (e) { setErr((e as Error).message || "Couldn't schedule. Try again."); } finally { setBusy(false); }
  };

  return (
    <div onClick={() => !busy && onClose()} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={sheet}>
        <button onClick={() => !busy && onClose()} aria-label="Close" style={closeX}>✕</button>
        <h2 className="section-h" style={{ marginTop: 0 }}>
          {step === "survey" ? "Site survey" : step === "schedule" ? "Schedule site survey" : "Place the battery"}
        </h2>
        <p className="muted small" style={{ marginTop: -6 }}>{project.customerName} · {project.address}</p>

        {/* STEP 1 — AR placement photos */}
        {step === "placement" && (
          <>
            <p className="muted small">
              Tap <strong>View in your space</strong> below to preview your <strong>{project.battery}</strong> in AR and snap photos of where it goes. Then tap <strong>+ Add photo</strong> and pick them from your library (or take a new one). <strong>2–3 photos.</strong> <span className="muted">({placement.length}/3)</span>
            </p>
            <div style={{ marginBottom: 12, borderRadius: 12, overflow: "hidden", border: "1px solid rgba(255,255,255,0.1)", background: "rgba(8,5,18,0.4)" }}>
              <BatteryAR accent={batteryContent(project.batteryProductId || "").accent} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
              {placement.map((s, i) => (
                <div key={i} style={{ width: 96 }}>
                  <img src={s.file ? URL.createObjectURL(s.file) : s.url} alt="" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8 }} />
                  <input value={s.note} placeholder="note" onChange={(e) => setPlacement((p) => p.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} style={{ width: "100%", marginTop: 4, fontSize: 11 }} />
                  <button className="btn ghost sm" style={{ width: "100%", marginTop: 2 }} onClick={() => setPlacement((p) => p.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
              {placement.length < 3 && (
                <button className="btn primary sm" style={{ width: 96, height: 96 }} onClick={() => placementInput.current?.click()}>+ Add photo</button>
              )}
              {/* No `capture` attribute → the picker offers Library OR Camera, so the
                  rep can add the photos they took inside AR (saved to the camera roll). */}
              <input ref={placementInput} type="file" accept="image/*" multiple hidden onChange={(e) => { addPlacementFiles(e.target.files); e.currentTarget.value = ""; }} />
            </div>
            {err && <p className="muted small" style={{ color: "#ef4444" }}>{err}</p>}
            <button className="btn primary block" style={{ marginTop: 14 }} onClick={goToChoice} disabled={busy || placement.length < 2}>
              {busy ? "Saving photos…" : "Next →"}
            </button>
          </>
        )}

        {/* STEP 2 — complete now or schedule */}
        {step === "choice" && (
          <>
            <p className="muted small">Placement photos saved. What's next?</p>
            <button className="btn primary block" style={{ marginTop: 12 }} onClick={() => { setErr(""); setStep("survey"); }}>✅ Complete site survey now</button>
            <button className="btn block" style={{ marginTop: 10 }} onClick={() => { setErr(""); setStep("schedule"); }}>📅 Schedule site survey</button>
            <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setStep("placement")}>← Back to photos</button>
          </>
        )}

        {/* STEP 3a — full survey */}
        {step === "survey" && (
          <>
            <h3 style={h3}>Site-survey photos</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10 }}>
              {SURVEY_PHOTOS.map((slot) => (
                <label key={slot.key} style={photoSlot(!!photos[slot.key])}>
                  {photos[slot.key] ? (
                    <img src={URL.createObjectURL(photos[slot.key] as File)} alt="" style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 6 }} />
                  ) : (
                    <span style={{ fontSize: 22, opacity: 0.6 }}>＋</span>
                  )}
                  <span style={{ fontSize: 11, lineHeight: 1.2, marginTop: 4, textAlign: "center" }}>{slot.label}</span>
                  <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhotos((m) => ({ ...m, [slot.key]: f })); e.currentTarget.value = ""; }} />
                </label>
              ))}
            </div>
            <h3 style={h3}>Checklist</h3>
            <div style={{ display: "grid", gap: 6 }}>
              {CHECKLIST.map((c) => (
                <label key={c.key} style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 13.5, cursor: "pointer" }}>
                  <input type="checkbox" checked={!!checklist[c.key]} onChange={(e) => setChecklist((m) => ({ ...m, [c.key]: e.target.checked }))} />
                  {c.label}
                </label>
              ))}
            </div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes for the project manager (access, gate codes, panel details…)" style={{ width: "100%", marginTop: 14, minHeight: 70 }} />
            {err && <p className="muted small" style={{ color: "#ef4444" }}>{err}</p>}
            <button className="btn primary block" style={{ marginTop: 10 }} onClick={submitNow} disabled={busy}>
              {busy ? "Uploading & submitting…" : "Submit for project-management review"}
            </button>
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setStep("choice")}>← Back</button>
          </>
        )}

        {/* STEP 3b — schedule */}
        {step === "schedule" && (
          <>
            <p className="muted small">Pick when you'll return to complete the full site survey. The placement photos are already saved.</p>
            <label className="field-label bt-field-label">Site survey date &amp; time</label>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} style={{ width: "100%" }} />
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes for the project manager…" style={{ width: "100%", marginTop: 12, minHeight: 60 }} />
            {err && <p className="muted small" style={{ color: "#ef4444" }}>{err}</p>}
            <button className="btn primary block" style={{ marginTop: 10 }} onClick={doSchedule} disabled={busy || !when}>
              {busy ? "Scheduling…" : "Create site survey appointment"}
            </button>
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setStep("choice")}>← Back</button>
          </>
        )}
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 6000, background: "rgba(6,4,14,0.72)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" };
const sheet: React.CSSProperties = { position: "relative", width: "min(560px,96vw)", margin: "24px 0", background: "#150f1f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, padding: "22px 20px 20px", boxShadow: "0 30px 80px rgba(0,0,0,0.6)" };
const closeX: React.CSSProperties = { position: "absolute", top: 12, right: 12, width: 32, height: 32, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.18)", background: "transparent", color: "#fff", cursor: "pointer" };
const h3: React.CSSProperties = { fontSize: 14, fontWeight: 700, margin: "18px 0 8px" };
const photoSlot = (filled: boolean): React.CSSProperties => ({ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 110, padding: 8, borderRadius: 10, border: `1px ${filled ? "solid" : "dashed"} rgba(255,255,255,0.2)`, background: "rgba(8,5,18,0.5)", cursor: "pointer", color: "#cfc7e2" });
