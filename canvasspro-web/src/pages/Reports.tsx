import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { DISP_LABEL, DISP_COLOR } from "../lib/dispositions";
import type { UserProfile } from "../types";

interface Funnel { doors: number; conv: number; appt: number; closed: number }
interface ReportLead { id: string; address: string; status: string; knockedAt: number; soldAt: number | null }
interface PitchItem {
  id: string; address: string; createdAt: number; status: string;
  score: number | null; highlight: string; lowlight: string; feedback: string;
}
interface Report {
  rep: { uid: string; displayName: string; email: string; title: string; role: string };
  funnel: { today: Funnel; week: Funnel; month: Funnel; all: Funnel };
  stats: { sales?: number; appointments?: number; doorsKnocked?: number; shifts?: number };
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
  const [busyLead, setBusyLead] = useState<string>("");

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

  const markSold = async (leadId: string) => {
    setBusyLead(leadId);
    try {
      await httpsCallable(functions, "setLeadStatusForRep")({ leadId, status: "sold" });
      if (sel) await loadReport(sel);
    } catch (e) {
      console.error("setLeadStatusForRep", e);
      alert((e as Error).message || "Could not set the close.");
    } finally {
      setBusyLead("");
    }
  };

  const windows = useMemo(
    () => report ? ([["Today", report.funnel.today], ["This week", report.funnel.week], ["This month", report.funnel.month], ["All time", report.funnel.all]] as [string, Funnel][]) : [],
    [report]
  );

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>📊 Reports</h1>
        <p className="page-sub">{role === "admin" ? "Anyone in your company" : "Your team"} — detailed activity, and set closes on their behalf.</p>
      </div>

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

            <h3 className="section-h" style={{ marginTop: 16 }}>Funnel</h3>
            <div style={{ overflowX: "auto" }}>
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
            </div>

            <div className="muted small" style={{ marginTop: 12 }}>
              Lifetime: {report.stats.sales ?? 0} sold · {report.stats.appointments ?? 0} appts · {report.stats.doorsKnocked ?? 0} doors ·
              {" "}{report.shiftHours.week}h on shift this week
            </div>
          </div>

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

          <div className="card" style={{ marginTop: 16 }}>
            <h3 className="section-h" style={{ marginTop: 0 }}>Leads <span className="muted small">({report.leads.length})</span></h3>
            {report.leads.length === 0 ? (
              <div className="muted">No leads yet.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="rep-leads">
                  <thead><tr><th>Address</th><th>Status</th><th>Knocked</th><th></th></tr></thead>
                  <tbody>
                    {report.leads.map((l) => (
                      <tr key={l.id}>
                        <td>{l.address || "—"}</td>
                        <td><span className="disp-dot" style={{ background: DISP_COLOR[l.status] || "#888" }} /> {DISP_LABEL[l.status] || l.status}</td>
                        <td className="muted">{fmtDate(l.knockedAt)}</td>
                        <td>
                          {l.status !== "sold" && (
                            <button className="btn sm" disabled={busyLead === l.id} onClick={() => markSold(l.id)}>
                              {busyLead === l.id ? "…" : "Mark sold"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
