import { useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

// A node in the Company → Regions → Teams → Users rollup returned by the
// getCompanyRollup callable. Every level carries the same setter + closer
// metrics, so one shape renders at any depth.
export interface RollupNode {
  type: "company" | "region" | "team" | "user";
  id: string | null;
  name: string;
  doors: number;
  setterAppts: number; setterSits: number; setterPitched: number;
  closerAppts: number; closerSits: number; closes: number; turnedAways: number;
  closerDispositioned?: number; closerDue?: number;
  closerEnded?: number; closerEndedDispositioned?: number;
  reps: number; closerReps: number;
  sitRate: number | null; closeRate: number | null; dispoRate?: number | null; endDispoRate?: number | null;
  isCloser?: boolean;
  regions?: RollupNode[]; teams?: RollupNode[]; users?: RollupNode[];
}
interface RollupResult { period: string; scopedToDownline: boolean; company: RollupNode }

export const ROLLUP_PERIODS: [string, string][] = [
  ["day", "Today"], ["week", "This week"], ["month", "This month"], ["year", "This year"], ["alltime", "All time"],
];

const pctText = (v: number | null) => (v == null ? "—" : `${v}%`);
function childrenOf(n: RollupNode): RollupNode[] {
  return n.regions ?? n.teams ?? n.users ?? [];
}
const childLabel = (n: RollupNode) =>
  n.regions ? "Regions" : n.teams ? "Teams" : n.users ? "Reps" : "";

export function useCompanyRollup(period: string) {
  const [data, setData] = useState<RollupResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setLoading(true); setErr("");
    httpsCallable(functions, "getCompanyRollup")({ period })
      .then((r) => { if (live) setData(r.data as RollupResult); })
      .catch((e) => { if (live) setErr((e as Error)?.message || "Couldn't load company results."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [period]);
  return { data, loading, err };
}

// Compact "Town Hall" summary — the company's (or a manager's downline's)
// totals for the period. Shown on the field Dashboard for admins/managers.
export function TownHallCard() {
  const [period, setPeriod] = useState("day"); // live daily snapshot by default
  const { data, loading, err } = useCompanyRollup(period);
  const c = data?.company;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>🏛 Town Hall{data?.scopedToDownline ? " · your team" : ""}</h2>
        <select className="input" style={{ width: "auto" }} value={period} onChange={(e) => setPeriod(e.target.value)}>
          {ROLLUP_PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {err && <div className="muted small" style={{ marginTop: 8 }}>{err}</div>}
      {loading && !c && <div className="muted small" style={{ marginTop: 8 }}>Loading…</div>}
      {c && (
        <>
          <div className="stat-grid tight" style={{ marginTop: 12 }}>
            <div className="stat-cell"><div className="stat-num">{c.doors}</div><div className="muted small">🚪 Doors</div></div>
            <div className="stat-cell"><div className="stat-num">{c.setterAppts}</div><div className="muted small">📅 Appts set</div></div>
            <div className="stat-cell"><div className="stat-num">{(c.closerEnded || 0) > 0 ? `${Math.round(((c.closerEndedDispositioned || 0) / (c.closerEnded || 1)) * 100)}%` : "—"}</div><div className="muted small">📋 {c.closerEndedDispositioned || 0}/{c.closerEnded || 0} dispositioned</div></div>
            <div className="stat-cell"><div className="stat-num">{c.setterSits}</div><div className="muted small">🪑 Sat</div></div>
            <div className="stat-cell"><div className="stat-num">{pctText(c.sitRate)}</div><div className="muted small">Sit %</div></div>
            <div className="stat-cell"><div className="stat-num">{c.closes}</div><div className="muted small">💰 Closed</div></div>
            <div className="stat-cell"><div className="stat-num">{pctText(c.closeRate)}</div><div className="muted small">Close %</div></div>
          </div>
          <div className="muted small" style={{ marginTop: 10 }}>
            {c.reps} active rep{c.reps === 1 ? "" : "s"} · Sit % = sat ÷ appointments that have occurred · Close % = closed ÷ closer sits.
            {" "}Open <strong>Reports</strong> to drill into regions, teams &amp; reps.
          </div>
        </>
      )}
    </div>
  );
}

// Full drill-down: Company → Regions → Teams → Reps, with sit% & close% at each
// level. Used in the Reports tab.
export function CompanyDrilldown() {
  const [period, setPeriod] = useState("week");
  const { data, loading, err } = useCompanyRollup(period);
  // Path of node ids from the company root to the current node.
  const [path, setPath] = useState<string[]>([]);

  // Resolve the current node (and the breadcrumb trail) by walking the path.
  const { node, trail } = useMemo(() => {
    const trail: RollupNode[] = [];
    let cur = data?.company || null;
    if (cur) trail.push(cur);
    for (const id of path) {
      const next = cur ? childrenOf(cur).find((k) => k.id === id) : null;
      if (!next) break;
      trail.push(next); cur = next;
    }
    return { node: cur, trail };
  }, [data, path]);

  if (loading && !data) return <div className="muted">Loading company results…</div>;
  if (err) return <div className="muted">{err}</div>;
  if (!node) return null;

  const kids = childrenOf(node);
  const kidLabel = childLabel(node);

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {trail.map((n, i) => (
              <span key={n.id ?? i} className="row" style={{ gap: 6, alignItems: "center" }}>
                {i > 0 && <span className="muted">›</span>}
                {i < trail.length - 1
                  ? <button className="linklike" onClick={() => setPath(path.slice(0, i))}>{n.name}</button>
                  : <strong>{n.name}</strong>}
              </span>
            ))}
          </div>
          <select className="input" style={{ width: "auto" }} value={period} onChange={(e) => { setPeriod(e.target.value); setPath([]); }}>
            {ROLLUP_PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {data?.scopedToDownline && <div className="muted small" style={{ marginTop: 6 }}>Showing your downline.</div>}

        {/* Totals for the current scope */}
        <div className="stat-grid tight" style={{ marginTop: 14 }}>
          <div className="stat-cell"><div className="stat-num">{node.doors}</div><div className="muted small">🚪 Doors</div></div>
          <div className="stat-cell"><div className="stat-num">{node.setterAppts}</div><div className="muted small">📅 Appts set</div></div>
          <div className="stat-cell"><div className="stat-num">{node.setterSits}</div><div className="muted small">🪑 Sat</div></div>
          <div className="stat-cell"><div className="stat-num">{pctText(node.sitRate)}</div><div className="muted small">Sit %</div></div>
          <div className="stat-cell"><div className="stat-num">{node.closes}</div><div className="muted small">💰 Closed</div></div>
          <div className="stat-cell"><div className="stat-num">{pctText(node.closeRate)}</div><div className="muted small">Close %</div></div>
        </div>
      </div>

      {kids.length > 0 ? (
        <div className="card">
          <h3 className="section-h" style={{ marginTop: 0 }}>{kidLabel}</h3>
          <div style={{ overflowX: "auto" }}>
            <table className="rep-funnel rollup-table">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{kidLabel.replace(/s$/, "")}</th>
                  <th>🚪 Doors</th>
                  <th>📅 Set</th>
                  <th>🪑 Sat</th>
                  <th>Sit %</th>
                  <th>💰 Closed</th>
                  <th>Close %</th>
                </tr>
              </thead>
              <tbody>
                {kids.map((k) => {
                  const drillable = childrenOf(k).length > 0;
                  return (
                    <tr key={k.id} className={drillable ? "drillable" : ""}
                      onClick={drillable ? () => setPath([...path, k.id!]) : undefined}>
                      <td style={{ textAlign: "left" }}>
                        {k.name}{k.type === "user" && k.isCloser ? <span className="muted small"> · closer</span> : ""}
                        {drillable && <span className="muted small"> ›</span>}
                      </td>
                      <td>{k.doors}</td>
                      <td>{k.setterAppts}</td>
                      <td>{k.setterSits}</td>
                      <td>{pctText(k.sitRate)}</td>
                      <td>{k.closes}</td>
                      <td>{pctText(k.closeRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="muted small" style={{ marginTop: 10 }}>
            Tap a row with a <strong>›</strong> to drill in. Sit % = sat ÷ appointments that have occurred · Close % = closed ÷ closer sits.
          </div>
        </div>
      ) : (
        <div className="card">
          <h3 className="section-h" style={{ marginTop: 0 }}>{node.name}</h3>
          <div className="stat-grid tight">
            <div className="stat-cell"><div className="stat-num">{node.closerAppts}</div><div className="muted small">Assigned (closer)</div></div>
            <div className="stat-cell"><div className="stat-num">{node.closerSits}</div><div className="muted small">Closer sat</div></div>
            <div className="stat-cell"><div className="stat-num">{node.turnedAways}</div><div className="muted small">Turned away</div></div>
          </div>
          <div className="muted small" style={{ marginTop: 10 }}>Individual rep totals for the period.</div>
        </div>
      )}
    </>
  );
}
