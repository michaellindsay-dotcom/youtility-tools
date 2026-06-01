import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import GoalPlanner from "../components/GoalPlanner";
import ShiftsPanel from "../components/ShiftsPanel";
import type { UserStats } from "../types";

type Metric = keyof Pick<UserStats, "sales" | "appointments" | "leadsCreated" | "doorsKnocked">;
const METRICS: { key: Metric; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "appointments", label: "Appts" },
  { key: "leadsCreated", label: "Leads" },
  { key: "doorsKnocked", label: "Doors" },
];

export default function Stats() {
  const { profile, role, companyId } = useAuth();
  const [rows, setRows] = useState<UserStats[]>([]);
  const [sortBy, setSortBy] = useState<Metric>("sales");

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "userStats");
    // Admins see the whole company; everyone else their downstream + self.
    const q =
      role === "admin"
        ? query(base, where("companyId", "==", companyId))
        : query(
            base,
            where("companyId", "==", companyId),
            where("managerPath", "array-contains", profile.uid)
          );
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserStats, "uid">) }));
      setRows(list);
    });
  }, [profile, role, companyId]);

  const sorted = [...rows].sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0));

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>Stats &amp; Leaderboard</h1>
          <p className="page-sub">
            {role === "admin" ? "Company" : "Your downstream"} performance.
          </p>
        </div>
        <div className="filter-bar">
          {METRICS.map((m) => (
            <button
              key={m.key}
              className={"chip-btn" + (sortBy === m.key ? " active" : "")}
              onClick={() => setSortBy(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <GoalPlanner />

      <h2 className="section-h">Shifts</h2>
      <ShiftsPanel />

      <h2 className="section-h">Leaderboard</h2>

      {sorted.length === 0 ? (
        <div className="empty">No stats yet — they build up as the team works leads and shifts.</div>
      ) : (
        <div className="card table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Rep</th>
                {METRICS.map((m) => (
                  <th key={m.key}>{m.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.uid}>
                  <td className="muted">{i + 1}</td>
                  <td>{r.userName || r.uid}</td>
                  {METRICS.map((m) => (
                    <td key={m.key} className={m.key === sortBy ? "stat-hl" : undefined}>
                      {r[m.key] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
