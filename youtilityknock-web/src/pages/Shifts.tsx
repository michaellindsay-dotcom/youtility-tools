import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { hasFeature } from "../lib/features";
import GoalPlanner from "../components/GoalPlanner";
import ShiftsPanel from "../components/ShiftsPanel";
import type { UserStats } from "../types";

// The "Success Planner" surface — the merged home for goal planning and team
// analytics. Layout top-to-bottom: the goal/pace planner, then the performance
// leaderboard ("the data"), then the shift time keeper at the bottom. This was
// previously split across two screens (Success Planner + Analytics); they're now
// one. Each half still honors its own plan feature: the goal planner and shift
// clock need `planner`, the leaderboard needs `analytics`. The page shows if a
// company has either one.

type Metric = keyof Pick<UserStats, "sales" | "appointments" | "leadsCreated" | "doorsKnocked">;
const METRICS: { key: Metric; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "appointments", label: "Appts" },
  { key: "leadsCreated", label: "Leads" },
  { key: "doorsKnocked", label: "Doors" },
];

export default function Shifts() {
  const { profile, role, companyId, company } = useAuth();
  const showPlanner = hasFeature(company, "planner"); // goal planner + shift clock
  const showAnalytics = hasFeature(company, "analytics"); // team leaderboard
  const [rows, setRows] = useState<UserStats[]>([]);
  const [sortBy, setSortBy] = useState<Metric>("sales");

  useEffect(() => {
    if (!profile || !companyId || !showAnalytics) return;
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
  }, [profile, role, companyId, showAnalytics]);

  const sorted = [...rows].sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0));

  return (
    <div className="page-body">
      <div className="page-head row">
        <div>
          <h1>Success Planner</h1>
          <p className="page-sub">
            Set your goal and see what it takes, track the team's performance, then clock your
            canvassing time. Door knocks count automatically while on shift.
          </p>
        </div>
        {showAnalytics && (
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
        )}
      </div>

      {/* Top: goal planner + the data */}
      {showPlanner && <GoalPlanner />}

      {showAnalytics && (
        <>
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
        </>
      )}

      {/* Bottom: the shift time keeper */}
      {showPlanner && (
        <>
          <h2 className="section-h">Shifts</h2>
          <ShiftsPanel />
        </>
      )}
    </div>
  );
}
