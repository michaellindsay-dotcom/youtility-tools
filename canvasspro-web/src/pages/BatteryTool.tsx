import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { addDoc, collection, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import {
  analyzeBill,
  estimateSolarDailyKWh,
  appliancesByCategory,
  computeLoad,
  recommendSystems,
  type SolarInput,
  type LoadResult,
  type SizingGoal,
  type RecommendedSystem,
  type SelectedLoad,
  type LoadCategory,
} from "../lib/batteries";

const fmt = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Fit badge colors — ideal=green, good=blue, undersized=amber.
const FIT_COLOR: Record<RecommendedSystem["fit"], string> = {
  ideal: "#34d399",
  good: "#3b82f6",
  undersized: "#f59e0b",
};
const FIT_LABEL: Record<RecommendedSystem["fit"], string> = {
  ideal: "Ideal fit",
  good: "Good fit",
  undersized: "Undersized",
};

// Recursively drop `undefined` so Firestore never rejects the write.
function clean<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map((v) => clean(v)) as unknown as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = v === undefined ? null : clean(v);
    }
    return out as T;
  }
  return obj;
}

// Whole-home default: every essential, plus the common HVAC + kitchen loads.
const WHOLE_HOME_IDS = ["furnace_fan", "ac_3ton", "microwave", "range", "dishwasher", "washer", "dryer_e", "waterHeater_e"];

interface SavedProposal {
  id: string;
  customerName?: string;
  address?: string | null;
  leadId?: string | null;
  bill?: ReturnType<typeof analyzeBill>;
  solar?: SolarInput;
  load?: LoadResult;
  goal?: SizingGoal;
  backupDays?: number;
  recommendation?: {
    productId: string;
    brand: string;
    model: string;
    units: number;
    totalUsableKWh: number;
    totalContinuousKW: number;
    totalPeakKW: number;
    backupDaysAchieved: number;
  };
  aiSummary?: string | null;
  createdAt?: number;
}

export default function BatteryTool() {
  const { profile, companyId } = useAuth();
  const [searchParams] = useSearchParams();

  // 1. Customer
  const [customerName, setCustomerName] = useState("");
  const [address, setAddress] = useState("");
  const [leadId, setLeadId] = useState<string | null>(null);
  useEffect(() => {
    const id = searchParams.get("leadId");
    if (id) setLeadId(id);
  }, [searchParams]);

  // 2. Bill analyzer
  const [monthlyKWh, setMonthlyKWh] = useState("");
  const [monthlyCost, setMonthlyCost] = useState("");
  const [ratePerKWh, setRatePerKWh] = useState("");
  const bill = useMemo(
    () =>
      analyzeBill({
        monthlyKWh: monthlyKWh ? Number(monthlyKWh) : undefined,
        monthlyCost: monthlyCost ? Number(monthlyCost) : undefined,
        ratePerKWh: ratePerKWh ? Number(ratePerKWh) : undefined,
      }),
    [monthlyKWh, monthlyCost, ratePerKWh]
  );

  // 3. Existing solar
  const [hasSolar, setHasSolar] = useState(false);
  const [systemKwDc, setSystemKwDc] = useState("");
  const [annualProductionKWh, setAnnualProductionKWh] = useState("");
  const solar = useMemo<SolarInput>(
    () => ({
      hasSolar,
      systemKwDc: systemKwDc ? Number(systemKwDc) : undefined,
      annualProductionKWh: annualProductionKWh ? Number(annualProductionKWh) : undefined,
    }),
    [hasSolar, systemKwDc, annualProductionKWh]
  );
  const solarDaily = useMemo(() => estimateSolarDailyKWh(solar), [solar]);

  // 4. Load calculator
  const [mode, setMode] = useState<"essentials" | "whole">("essentials");
  const [selected, setSelected] = useState<SelectedLoad[]>([]);
  const categories = useMemo(() => appliancesByCategory(), []);

  // Pre-select sensible defaults on first switch into a mode.
  const applyMode = (next: "essentials" | "whole") => {
    setMode(next);
    if (next === "essentials") {
      const ess: SelectedLoad[] = [];
      categories.forEach((arr) => arr.forEach((a) => { if (a.essential) ess.push({ applianceId: a.id, qty: 1 }); }));
      setSelected(ess);
    } else {
      const ids = new Set(WHOLE_HOME_IDS);
      const whole: SelectedLoad[] = [];
      categories.forEach((arr) => arr.forEach((a) => { if (a.essential || ids.has(a.id)) whole.push({ applianceId: a.id, qty: 1 }); }));
      setSelected(whole);
    }
  };
  // Seed the default essentials selection on first mount.
  useEffect(() => { applyMode("essentials"); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const diversity = mode === "essentials" ? 1.0 : 0.6;
  const qtyOf = (id: string) => selected.find((s) => s.applianceId === id)?.qty ?? 0;
  const setQty = (id: string, qty: number) =>
    setSelected((cur) => {
      const rest = cur.filter((s) => s.applianceId !== id);
      return qty > 0 ? [...rest, { applianceId: id, qty }] : rest;
    });
  const load = useMemo(() => computeLoad(selected, diversity), [selected, diversity]);

  // 5. Goal & backup
  const [goal, setGoal] = useState<SizingGoal>("both");
  const [backupDays, setBackupDays] = useState("1");
  const [preferLFP, setPreferLFP] = useState(false);

  // 6. Recommendation
  const recs = useMemo(
    () =>
      recommendSystems({
        load,
        goal,
        backupDays: Number(backupDays) || 1,
        dailyUsageKWh: bill.dailyKWh,
        solarDailyKWh: solarDaily,
        preferLFP,
      }),
    [load, goal, backupDays, bill.dailyKWh, solarDaily, preferLFP]
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  // Default the chosen system to the best rec; reset when the top rec changes.
  useEffect(() => { setChosenId(recs[0]?.product.id ?? null); }, [recs]);
  const chosen = useMemo(() => recs.find((r) => r.product.id === chosenId) ?? recs[0], [recs, chosenId]);

  // 7. Proposal
  const [aiSummary, setAiSummary] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  const generateSummary = async () => {
    if (!chosen) return;
    setAiLoading(true);
    setAiError("");
    try {
      const { data } = await httpsCallable<
        {
          customerName: string;
          bill: typeof bill;
          load: LoadResult;
          solar: SolarInput;
          recommendation: RecommendedSystem;
          goal: SizingGoal;
          backupDays: number;
        },
        { summary: string; error?: string }
      >(functions, "batteryProposalSummary")({
        customerName,
        bill,
        load,
        solar,
        recommendation: chosen,
        goal,
        backupDays: Number(backupDays) || 1,
      });
      if (data.summary) setAiSummary(data.summary);
      else setAiError(data.error || "No summary returned — showing the numbers.");
    } catch (e) {
      setAiError((e as Error).message || "AI summary is unavailable right now.");
    } finally {
      setAiLoading(false);
    }
  };

  const save = async () => {
    if (!profile || !companyId || !chosen) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const visibilityPath = [...new Set([profile.uid, ...(profile.managerPath ?? []), ...(profile.closerManagerPath ?? [])])];
      await addDoc(
        collection(db, "proposals"),
        clean({
          companyId,
          closerUid: profile.uid,
          closerName: profile.displayName || profile.email || "",
          visibilityPath,
          customerName,
          address: address || null,
          leadId: leadId || null,
          bill,
          solar,
          load,
          goal,
          backupDays: Number(backupDays) || 1,
          recommendation: {
            productId: chosen.product.id,
            brand: chosen.product.brand,
            model: chosen.product.model,
            units: chosen.units,
            totalUsableKWh: chosen.totalUsableKWh,
            totalContinuousKW: chosen.totalContinuousKW,
            totalPeakKW: chosen.totalPeakKW,
            backupDaysAchieved: chosen.backupDaysAchieved,
          },
          aiSummary: aiSummary || null,
          createdAt: Date.now(),
        })
      );
      setSaved(true);
    } catch (e) {
      setSaveError((e as Error).message || "Couldn't save the proposal. Try again.");
    } finally {
      setSaving(false);
    }
  };

  // My proposals
  const [myProposals, setMyProposals] = useState<SavedProposal[]>([]);
  useEffect(() => {
    if (!profile) return;
    // Single-field equality query → no composite index needed; sort client-side.
    return onSnapshot(
      query(collection(db, "proposals"), where("closerUid", "==", profile.uid)),
      (snap) =>
        setMyProposals(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<SavedProposal, "id">) }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        ),
      (e) => console.error("my proposals", e)
    );
  }, [profile]);

  // Repopulate the form from a saved proposal (best-effort).
  const loadProposal = (p: SavedProposal) => {
    setCustomerName(p.customerName || "");
    setAddress(p.address || "");
    setLeadId(p.leadId || null);
    if (p.bill) {
      setMonthlyKWh(String(p.bill.monthlyKWh ?? ""));
      setMonthlyCost(String(p.bill.monthlyCost ?? ""));
      setRatePerKWh(String(p.bill.ratePerKWh ?? ""));
    }
    if (p.solar) {
      setHasSolar(!!p.solar.hasSolar);
      setSystemKwDc(p.solar.systemKwDc != null ? String(p.solar.systemKwDc) : "");
      setAnnualProductionKWh(p.solar.annualProductionKWh != null ? String(p.solar.annualProductionKWh) : "");
    }
    if (p.goal) setGoal(p.goal);
    if (p.backupDays != null) setBackupDays(String(p.backupDays));
    if (p.recommendation?.productId) setChosenId(p.recommendation.productId);
    setAiSummary(p.aiSummary || "");
    setSaved(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>🔋 Battery Tool</h1>
        <p className="page-sub">Analyze the bill, size the load, and build a battery proposal.</p>
      </div>

      {/* 1. Customer */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="section-h" style={{ marginTop: 0 }}>Customer</h2>
        <label className="field">
          <span>Customer name</span>
          <input value={customerName} placeholder="Full name" onChange={(e) => setCustomerName(e.target.value)} />
        </label>
        <label className="field">
          <span>Address <span className="muted small">(optional)</span></span>
          <input value={address} placeholder="123 Main St" onChange={(e) => setAddress(e.target.value)} />
        </label>
        {leadId && <div className="muted small">Linked to lead {leadId}</div>}
      </div>

      {/* 2. Bill analyzer */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="section-h" style={{ marginTop: 0 }}>Bill analyzer</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Enter any two — we'll derive the rest.</p>
        <div className="grid-2">
          <label className="field">
            <span>Monthly usage (kWh)</span>
            <input type="number" inputMode="decimal" value={monthlyKWh} placeholder="900" onChange={(e) => setMonthlyKWh(e.target.value)} />
          </label>
          <label className="field">
            <span>Monthly bill ($)</span>
            <input type="number" inputMode="decimal" value={monthlyCost} placeholder="153" onChange={(e) => setMonthlyCost(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Rate ($/kWh)</span>
          <input type="number" inputMode="decimal" value={ratePerKWh} placeholder="0.17" onChange={(e) => setRatePerKWh(e.target.value)} />
        </label>
        <div className="stat-grid" style={{ marginTop: 8 }}>
          <div className="stat-card"><div className="stat-value">{bill.dailyKWh}</div><div className="stat-label">kWh / day</div></div>
          <div className="stat-card"><div className="stat-value">{bill.monthlyKWh}</div><div className="stat-label">kWh / mo</div></div>
          <div className="stat-card"><div className="stat-value">${bill.ratePerKWh}</div><div className="stat-label">$ / kWh</div></div>
          <div className="stat-card"><div className="stat-value">${Math.round(bill.annualCost).toLocaleString()}</div><div className="stat-label">Annual cost</div></div>
        </div>
        {bill.source !== "complete" && (
          <div className="muted small" style={{ marginTop: 8 }}>
            {bill.source === "derived" ? "Derived from the values entered." : "Estimated from US averages — enter two values for accuracy."}
          </div>
        )}
      </div>

      {/* 3. Existing solar */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="section-h" style={{ marginTop: 0 }}>Existing solar</h2>
        <label className="row" style={{ gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={hasSolar} onChange={(e) => setHasSolar(e.target.checked)} />
          <span>Homeowner already has solar</span>
        </label>
        {hasSolar && (
          <>
            <div className="grid-2" style={{ marginTop: 10 }}>
              <label className="field">
                <span>System size (kW DC)</span>
                <input type="number" inputMode="decimal" value={systemKwDc} placeholder="7.5" onChange={(e) => setSystemKwDc(e.target.value)} />
              </label>
              <label className="field">
                <span>Annual production (kWh) <span className="muted small">from their monitoring app, if available</span></span>
                <input type="number" inputMode="decimal" value={annualProductionKWh} placeholder="11000" onChange={(e) => setAnnualProductionKWh(e.target.value)} />
              </label>
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>≈ {solarDaily} kWh/day</div>
            <div className="muted small" style={{ marginTop: 4 }}>
              Live monitoring-app sync (Enphase/SolarEdge/Tesla) is coming — enter from their app for now.
            </div>
          </>
        )}
      </div>

      {/* 4. Load calculator */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="section-h" style={{ marginTop: 0 }}>Load calculator</h2>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <button className={"btn sm" + (mode === "essentials" ? " primary" : " ghost")} onClick={() => applyMode("essentials")}>Essentials backup</button>
          <button className={"btn sm" + (mode === "whole" ? " primary" : " ghost")} onClick={() => applyMode("whole")}>Whole home</button>
        </div>

        {[...categories.entries()].map(([cat, arr]) => (
          <div key={cat} style={{ marginBottom: 12 }}>
            <div className="field-label">{cat as LoadCategory}</div>
            <div className="lb-list">
              {arr.map((a) => {
                const q = qtyOf(a.id);
                return (
                  <div key={a.id} className="lb-row card" style={{ alignItems: "center" }}>
                    <div className="lb-row-main">
                      <div className="lb-row-name">{a.name}</div>
                      <div className="muted small">{a.runningW.toLocaleString()} W run · {a.startingW.toLocaleString()} W surge</div>
                    </div>
                    <div className="row" style={{ gap: 6, alignItems: "center" }}>
                      <button className="btn ghost sm" onClick={() => setQty(a.id, Math.max(0, q - 1))}>−</button>
                      <span style={{ minWidth: 18, textAlign: "center" }}>{q}</span>
                      <button className="btn ghost sm" onClick={() => setQty(a.id, q + 1)}>+</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="stat-grid" style={{ marginTop: 8 }}>
          <div className="stat-card"><div className="stat-value">{load.dailyKWh}</div><div className="stat-label">Daily energy</div><div className="muted small">kWh</div></div>
          <div className="stat-card"><div className="stat-value">{load.continuousKW}</div><div className="stat-label">Continuous</div><div className="muted small">kW</div></div>
          <div className="stat-card"><div className="stat-value">{load.peakKW}</div><div className="stat-label">Surge</div><div className="muted small">kW</div></div>
        </div>
      </div>

      {/* 5. Goal & backup */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="section-h" style={{ marginTop: 0 }}>Goal &amp; backup</h2>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          {(["backup", "savings", "both"] as SizingGoal[]).map((g) => (
            <button key={g} className={"btn sm" + (goal === g ? " primary" : " ghost")} onClick={() => setGoal(g)}>
              {g === "backup" ? "Backup" : g === "savings" ? "Savings" : "Both"}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Days of backup</span>
          <input type="number" inputMode="decimal" value={backupDays} onChange={(e) => setBackupDays(e.target.value)} />
        </label>
        <label className="row" style={{ gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={preferLFP} onChange={(e) => setPreferLFP(e.target.checked)} />
          <span>Prefer LFP chemistry</span>
        </label>
      </div>

      {/* 6. Recommendation */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="section-h" style={{ marginTop: 0 }}>Recommendation</h2>
        {!chosen ? (
          <div className="empty">Add some loads to size a system.</div>
        ) : (
          <>
            <div
              className="card"
              style={{ border: `2px solid ${FIT_COLOR[chosen.fit]}`, marginBottom: 12 }}
            >
              <div className="lb-row-top" style={{ marginBottom: 8 }}>
                <span className="lb-row-name" style={{ fontSize: 18 }}>
                  {chosen.units}× {chosen.product.brand} {chosen.product.model}
                </span>
                <span className="badge" style={{ background: FIT_COLOR[chosen.fit], color: "#06121f", fontWeight: 700 }}>
                  {FIT_LABEL[chosen.fit]}
                </span>
              </div>
              <div className="stat-grid" style={{ marginBottom: 8 }}>
                <div className="stat-card"><div className="stat-value">{chosen.totalUsableKWh}</div><div className="stat-label">Usable kWh</div></div>
                <div className="stat-card"><div className="stat-value">{chosen.totalContinuousKW}</div><div className="stat-label">Continuous kW</div></div>
                <div className="stat-card"><div className="stat-value">{chosen.totalPeakKW}</div><div className="stat-label">Surge kW</div></div>
                <div className="stat-card"><div className="stat-value">{chosen.backupDaysAchieved}</div><div className="stat-label">Backup days</div></div>
              </div>
              <div className="muted small">
                {chosen.product.chemistry} · {chosen.product.warrantyYears}-yr warranty
                {chosen.product.acCoupled ? " · AC-coupled" : ""}
              </div>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <span className="badge" style={{ background: chosen.meetsContinuous ? "#34d399" : "#ef4444", color: "#06121f", fontWeight: 700 }}>
                  {chosen.meetsContinuous ? "✓" : "✗"} Meets continuous power
                </span>
                <span className="badge" style={{ background: chosen.meetsSurge ? "#34d399" : "#ef4444", color: "#06121f", fontWeight: 700 }}>
                  {chosen.meetsSurge ? "✓" : "✗"} Meets surge
                </span>
              </div>
              {chosen.product.notes && <div className="muted small" style={{ marginTop: 8 }}>{chosen.product.notes}</div>}
            </div>

            {recs.length > 1 && (
              <>
                <div className="field-label">Alternatives</div>
                <div className="lb-list">
                  {recs.slice(1, 5).map((r) => (
                    <div
                      key={r.product.id}
                      className="lb-row card"
                      style={{ alignItems: "center", cursor: "pointer", ...(r.product.id === chosenId ? { borderColor: FIT_COLOR[r.fit] } : {}) }}
                      onClick={() => setChosenId(r.product.id)}
                    >
                      <div className="lb-row-main">
                        <div className="lb-row-top">
                          <span className="lb-row-name">{r.units}× {r.product.brand} {r.product.model}</span>
                          <span className="badge" style={{ background: FIT_COLOR[r.fit], color: "#06121f", fontWeight: 700 }}>
                            {FIT_LABEL[r.fit]}
                          </span>
                        </div>
                        <div className="muted small">
                          {r.totalUsableKWh} kWh · {r.totalContinuousKW} kW cont · {r.backupDaysAchieved} day backup · {r.product.chemistry}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* 7. Proposal */}
      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="section-h" style={{ marginTop: 0 }}>Proposal</h2>
        {chosen ? (
          <>
            <div className="muted small" style={{ marginBottom: 10 }}>
              {customerName || "Customer"}{address ? ` · ${address}` : ""} — {chosen.units}× {chosen.product.brand} {chosen.product.model}
              {" · "}{chosen.totalUsableKWh} kWh usable · {bill.dailyKWh} kWh/day usage
              {solar.hasSolar ? ` · ${solarDaily} kWh/day solar` : ""}
            </div>

            <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <button className="btn primary sm" onClick={generateSummary} disabled={aiLoading}>
                {aiLoading ? "Generating…" : "✨ Generate AI summary"}
              </button>
              <button className="btn primary sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "💾 Save proposal"}
              </button>
              <button className="btn ghost sm" onClick={() => window.print()}>🖨 Print</button>
            </div>

            {aiError && <p className="muted small" style={{ color: "#f59e0b" }}>{aiError}</p>}
            {aiSummary && <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{aiSummary}</p>}
            {saved && <p className="muted small" style={{ color: "#34d399" }}>✅ Proposal saved.</p>}
            {saveError && <p className="muted small" style={{ color: "#ef4444" }}>{saveError}</p>}
          </>
        ) : (
          <div className="empty">Size a system above to build the proposal.</div>
        )}
      </div>

      {/* My proposals */}
      <h2 className="section-h">My proposals</h2>
      {myProposals.length === 0 ? (
        <div className="empty">No saved proposals yet. Build one above and hit 💾 Save.</div>
      ) : (
        <div className="lb-list">
          {myProposals.map((p) => (
            <div key={p.id} className="lb-row card" style={{ alignItems: "center", cursor: "pointer" }} onClick={() => loadProposal(p)}>
              <div className="lb-row-main">
                <div className="lb-row-top">
                  <span className="lb-row-name">{p.customerName || "Customer"}</span>
                  <span className="muted small">{p.createdAt ? fmt(p.createdAt) : ""}</span>
                </div>
                <div className="muted small">
                  {p.recommendation
                    ? `${p.recommendation.units}× ${p.recommendation.brand} ${p.recommendation.model}`
                    : "—"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
