import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { CompanyDrilldown } from "../components/CompanyReport";
import type { UserProfile } from "../types";

interface Funnel { doors: number; conv: number; appt: number; closed: number }
interface CloserFunnel { appt: number; sat: number; closed: number }
interface ReportLead { id: string; address: string; status: string; knockedAt: number; soldAt: number | null }
interface PitchItem {
  id: string; address: string; createdAt: number; status: string;
  score: number | null; highlight: string; lowlight: string; feedback: string;
}
interface SitMetrics {
  isCloser: boolean;
  apptsSet: number; sits: number; pitchedAppts: number; sitRate: number | null;
  closerAppts: number; closerSits: number; closerCloses: number; closeRate: number | null;
  turnedAways: number;
}
interface Report {
  rep: { uid: string; displayName: string; email: string; title: string; role: string };
  funnel: { today: Funnel; week: Funnel; month: Funnel; all: Funnel };
  closerFunnel?: { today: CloserFunnel; week: CloserFunnel; month: CloserFunnel; all: CloserFunnel };
  stats: { sales?: number; appointments?: number; doorsKnocked?: number; shifts?: number };
  sitMetrics?: SitMetrics;
  lifetime?: { sold: number; appts: number; doors: number };
  shiftHours: { week: number; month: number };
  leads: ReportLead[];
  pitches?: { recent: PitchItem[]; best: PitchItem | null; worst: PitchItem | null; count: number };
}

function PitchBlock({ tag, p }: { tag: string; p: PitchItem }) {
  return (
    <div className="pitch-block">
      <div className="pitch-block-head">
        <span className="pitch-tag">{tag}</span>
        <span className="pitch-score">{p.score ?? "—"}<small>/100</small></span>
      </div>
      {p.feedback && <p className="pitch-fb">{p.feedback}</p>}
      {p.highlight && <p className="pitch-hi"><strong>✅ Best:</strong> {p.highlight}</p>}
      {p.lowlight && <p className="pitch-lo"><strong>⚠️ Fix:</strong> {p.lowlight}</p>}
    </div>
  );
}

const fmtDate = (ms: number) => ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

export default function Reports() {
  const { profile, role, companyId } = useAuth();
  const [team, setTeam] = useState<UserProfile[]>([]);
  const [sel, setSel] = useState<string>("");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"company" | "employee">("company");

  // Roster: admins see the whole company; managers see their downstream.
  useEffect(() => {
    if (!profile || !companyId) return;
    (async () => {
      const base = collection(db, "users");
      const q = role === "admin"
        ? query(base, where("companyId", "==", companyId))
        : query(base, where("companyId", "==", companyId), where("managerPath", "array-contains", profile.uid));
      const snap = await getDocs(q);
      const list = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserProfile, "uid">) }))
        .filter((u) => !u.disabled)
        .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
      setTeam(list);
    })().catch((e) => console.error("reports roster", e));
  }, [profile, role, companyId]);

  const loadReport = async (repUid: string) => {
    setSel(repUid);
    setReport(null);
    if (!repUid) return;
    setLoading(true);
    try {
      const { data } = await httpsCallable(functions, "getEmployeeReport")({ repUid });
      setReport(data as Report);
    } catch (e) {
      console.error("getEmployeeReport", e);
    } finally {
      setLoading(false);
    }
  };

  const windows = useMemo(
    () => report ? ([["Today", report.funnel.today], ["This week", report.funnel.week], ["This month", report.funnel.month], ["All time", report.funnel.all]] as [string, Funnel][]) : [],
    [report]
  );
  // A pure closer has no self-gen door/appt funnel — show their closer funnel
  // (appointments assigned → sat → closed) so the numbers match their production.
  const pureCloser = !!report?.sitMetrics?.isCloser && report.funnel.all.doors === 0 && report.funnel.all.appt === 0;
  const closerWindows = useMemo(
    () => (report?.closerFunnel ? ([["Today", report.closerFunnel.today], ["This week", report.closerFunnel.week], ["This month", report.closerFunnel.month], ["All time", report.closerFunnel.all]] as [string, CloserFunnel][]) : []),
    [report]
  );

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>📊 Reports</h1>
        <p className="page-sub">{role === "admin" ? "Whole company" : "Your downline"} — company totals with region, team &amp; rep drill-down, or one person in detail.</p>
      </div>

      <div className="seg-toggle" style={{ marginBottom: 16 }}>
        <button className={mode === "company" ? "active" : ""} onClick={() => setMode("company")}>🏢 Company</button>
        <button className={mode === "employee" ? "active" : ""} onClick={() => setMode("employee")}>👤 By employee</button>
      </div>

      {mode === "company" && <CompanyDrilldown />}

      {mode === "employee" && (
      <>
      <div className="card" style={{ marginBottom: 16 }}>
        <label className="muted small" htmlFor="rep-select">Employee</label>
        <select id="rep-select" className="input" value={sel} onChange={(e) => loadReport(e.target.value)} style={{ marginTop: 6 }}>
          <option value="">— select an employee —</option>
          {team.map((u) => (
            <option key={u.uid} value={u.uid}>{u.displayName || u.email}{u.title ? ` · ${u.title}` : ""}</option>
          ))}
        </select>
      </div>

      {loading && <div className="muted">Loading report…</div>}

      {report && !loading && (
        <>
          <div className="card">
            <h2>{report.rep.displayName || report.rep.email}</h2>
            <div className="muted small" style={{ marginTop: -6 }}>{report.rep.title || report.rep.role} · {report.rep.email}</div>

            <h3 className="section-h" style={{ marginTop: 16 }}>Funnel{pureCloser ? " · closer" : ""}</h3>
            <div style={{ overflowX: "auto" }}>
              {pureCloser && report.closerFunnel ? (
                <table className="rep-funnel">
                  <thead>
                    <tr><th></th>{closerWindows.map(([label]) => <th key={label}>{label}</th>)}</tr>
                  </thead>
                  <tbody>
                    <tr><td>📅 Appointments</td>{closerWindows.map(([l, f]) => <td key={l}>{f.appt}</td>)}</tr>
                    <tr><td>🪑 Sat</td>{closerWindows.map(([l, f]) => <td key={l}>{f.sat}</td>)}</tr>
                    <tr><td>💰 Closed</td>{closerWindows.map(([l, f]) => <td key={l}>{f.closed}</td>)}</tr>
                    <tr className="muted"><td>Close rate</td>{closerWindows.map(([l, f]) => <td key={l}>{pct(f.closed, f.sat)}%</td>)}</tr>
                  </tbody>
                </table>
              ) : (
                <table className="rep-funnel">
                  <thead>
                    <tr><th></th>{windows.map(([label]) => <th key={label}>{label}</th>)}</tr>
                  </thead>
                  <tbody>
                    <tr><td>🚪 Doors</td>{windows.map(([l, f]) => <td key={l}>{f.doors}</td>)}</tr>
                    <tr><td>💬 Conversations</td>{windows.map(([l, f]) => <td key={l}>{f.conv}</td>)}</tr>
                    <tr><td>📅 Appointments</td>{windows.map(([l, f]) => <td key={l}>{f.appt}</td>)}</tr>
                    <tr><td>💰 Closed</td>{windows.map(([l, f]) => <td key={l}>{f.closed}</td>)}</tr>
                    <tr className="muted"><td>Close rate</td>{windows.map(([l, f]) => <td key={l}>{pct(f.closed, f.appt)}%</td>)}</tr>
                  </tbody>
                </table>
              )}
            </div>

            <div className="muted small" style={{ marginTop: 12 }}>
              Lifetime: {pureCloser && report.closerFunnel ? report.closerFunnel.all.closed : (report.lifetime?.sold ?? report.funnel.all.closed)} {pureCloser ? "closed" : "sold"} · {pureCloser && report.closerFunnel ? report.closerFunnel.all.appt : (report.lifetime?.appts ?? report.funnel.all.appt)} appts{pureCloser ? "" : ` · ${report.lifetime?.doors ?? report.funnel.all.doors} doors`} ·
              {" "}{report.shiftHours.week}h on shift this week
            </div>
          </div>

          {report.sitMetrics && (() => {
            const m = report.sitMetrics!;
            const showSetter = m.apptsSet > 0 || m.sits > 0 || m.pitchedAppts > 0;
            const showCloser = m.isCloser || m.closerSits > 0 || m.closerCloses > 0 || m.closerAppts > 0;
            if (!showSetter && !showCloser) return null;
            return (
              <div className="card" style={{ marginTop: 16 }}>
                <h3 className="section-h" style={{ marginTop: 0 }}>🎯 Sit &amp; close rates <span className="muted small">(all-time)</span></h3>
                {showSetter && (
                  <div style={{ marginBottom: showCloser ? 14 : 0 }}>
                    <div className="muted small" style={{ marginBottom: 6 }}>As a setter</div>
                    <div className="stat-grid tight">
                      <div className="stat-cell"><div className="stat-num">{m.apptsSet}</div><div className="muted small">Appts set</div></div>
                      <div className="stat-cell"><div className="stat-num">{m.sits}</div><div className="muted small">Sat</div></div>
                      <div className="stat-cell"><div className="stat-num">{m.pitchedAppts}</div><div className="muted small">Pitched appts</div></div>
                      <div className="stat-cell"><div className="stat-num">{m.sitRate == null ? "—" : `${m.sitRate}%`}</div><div className="muted small">Sit rate</div></div>
                    </div>
                    <div className="muted small" style={{ marginTop: 6 }}>
                      Sit rate = sat ÷ pitched appointments. Homeowner turn-aways are excluded from pitched appointments.
                    </div>
                  </div>
                )}
                {showCloser && (
                  <div>
                    <div className="muted small" style={{ marginBottom: 6 }}>As a closer</div>
                    <div className="stat-grid tight">
                      <div className="stat-cell"><div className="stat-num">{m.closerAppts}</div><div className="muted small">Assigned</div></div>
                      <div className="stat-cell"><div className="stat-num">{m.closerSits}</div><div className="muted small">Sat</div></div>
                      <div className="stat-cell"><div className="stat-num">{m.closerCloses}</div><div className="muted small">Closed</div></div>
                      <div className="stat-cell"><div className="stat-num">{m.closeRate == null ? "—" : `${m.closeRate}%`}</div><div className="muted small">Close rate</div></div>
                      <div className="stat-cell"><div className="stat-num">{m.turnedAways}</div><div className="muted small">Turned away</div></div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {report.pitches && report.pitches.count > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3 className="section-h" style={{ marginTop: 0 }}>🎙️ Pitch coaching <span className="muted small">({report.pitches.count} recorded)</span></h3>
              <div className="dash-2col">
                {report.pitches.best && <PitchBlock tag="🏆 Best pitch" p={report.pitches.best} />}
                {report.pitches.worst && report.pitches.worst.id !== report.pitches.best?.id && <PitchBlock tag="📉 Needs work" p={report.pitches.worst} />}
              </div>
              <details style={{ marginTop: 12 }}>
                <summary className="muted small" style={{ cursor: "pointer" }}>All recordings ({report.pitches.recent.length})</summary>
                <ul className="pitch-list">
                  {report.pitches.recent.map((p) => (
                    <li key={p.id}>
                      <span className="muted small">{fmtDate(p.createdAt)}{p.address ? ` · ${p.address}` : ""}</span>
                      {" — "}
                      {p.status === "analyzed" ? <><strong>{p.score ?? "—"}/100</strong>{p.feedback ? ` · ${p.feedback}` : ""}</>
                        : p.status === "error" ? <span className="muted">{p.feedback || "analysis failed"}</span>
                        : <span className="muted">{p.status}…</span>}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}

        </>
      )}
      </>
      )}
    </div>
  );
}
