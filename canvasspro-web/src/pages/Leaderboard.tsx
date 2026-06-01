import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { UserStats } from "../types";

type Metric = "sales" | "appointments" | "doorsKnocked" | "leadsCreated";
const METRICS: { key: Metric; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "appointments", label: "Appointments" },
  { key: "doorsKnocked", label: "Doors" },
  { key: "leadsCreated", label: "Leads" },
];

export default function Leaderboard() {
  const { profile, role, companyId } = useAuth();
  const [rows, setRows] = useState<UserStats[]>([]);
  const [sortBy, setSortBy] = useState<Metric>("sales");

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "userStats");
    const q =
      role === "admin"
        ? query(base, where("companyId", "==", companyId))
        : query(base, where("companyId", "==", companyId), where("managerPath", "array-contains", profile.uid));
    return onSnapshot(q, (snap) =>
      setRows(snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserStats, "uid">) })))
    );
  }, [profile, role, companyId]);

  const ranked = useMemo(() => [...rows].sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0)), [rows, sortBy]);
  const myRank = ranked.findIndex((r) => r.uid === profile?.uid);
  const me = myRank >= 0 ? ranked[myRank] : null;
  const rate = (n?: number, d?: number) => (d ? Math.round(((n ?? 0) / d) * 100) : 0);

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>Leaderboard</h1>
          <p className="page-sub">{role === "admin" ? "Company" : "Your team"} rankings.</p>
        </div>
        <div className="filter-bar">
          {METRICS.map((m) => (
            <button key={m.key} className={"chip-btn" + (sortBy === m.key ? " active" : "")} onClick={() => setSortBy(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {me && (
        <div className="card dash-progress" style={{ marginBottom: 16 }}>
          <div>
            <strong>Your rank: #{myRank + 1}</strong>
            <div className="muted small">
              {me.sales ?? 0} sold · {me.appointments ?? 0} appts · {me.doorsKnocked ?? 0} doors ·{" "}
              {rate(me.sales, me.leadsCreated)}% close
            </div>
          </div>
        </div>
      )}

      {ranked.length === 0 ? (
        <div className="empty">No stats yet — they build up as the team works leads and shifts.</div>
      ) : (
        <div className="card table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Rep</th>
                <th>Doors</th>
                <th>Appts</th>
                <th>Sales</th>
                <th>Close %</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((r, i) => (
                <tr key={r.uid} className={r.uid === profile?.uid ? "me-row" : undefined}>
                  <td className="muted">{i + 1}</td>
                  <td>{r.userName || r.uid}</td>
                  <td>{r.doorsKnocked ?? 0}</td>
                  <td>{r.appointments ?? 0}</td>
                  <td className={sortBy === "sales" ? "stat-hl" : undefined}>{r.sales ?? 0}</td>
                  <td>{rate(r.sales, r.leadsCreated)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
