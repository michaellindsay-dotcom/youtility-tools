import { useEffect, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { useShift, fmtElapsed } from "../shift/ShiftContext";
import type { Shift } from "../types";

// Shift clock + recent-shifts table. Rendered at the bottom of the Success
// Planner screen, beneath the goal planner and team leaderboard.
export default function ShiftsPanel() {
  const { profile, role, companyId } = useAuth();
  const { active, elapsedSec, doors, starting, startShift, stopShift } = useShift();
  const [shifts, setShifts] = useState<Shift[]>([]);

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "shifts");
    const q =
      role === "admin"
        ? query(base, where("companyId", "==", companyId), orderBy("startAt", "desc"), limit(50))
        : query(
            base,
            where("companyId", "==", companyId),
            where("visibilityPath", "array-contains", profile.uid),
            orderBy("startAt", "desc"),
            limit(50)
          );
    return onSnapshot(q, (snap) => setShifts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Shift, "id">) }))));
  }, [profile, role, companyId]);

  const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleString() : "—");
  const dur = (s: Shift) => {
    const mins = Math.round(((s.endAt ?? Date.now()) - s.startAt) / 60000);
    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  };

  return (
    <>
      <div className="card shift-control">
        {active ? (
          <>
            <div>
              <div className="shift-live">● On shift — <span className="mono">{fmtElapsed(elapsedSec)}</span></div>
              <div className="muted">Doors this shift: <strong>{doors}</strong> · auto-stops after 5 min idle</div>
            </div>
            <button className="btn primary" onClick={() => stopShift()}>Stop shift</button>
          </>
        ) : (
          <>
            <div className="muted">You're not on a shift.</div>
            <button className="btn primary" onClick={() => startShift()} disabled={starting}>
              {starting ? "Starting…" : "▶ Start shift"}
            </button>
          </>
        )}
      </div>

      <h2 className="section-h">Recent shifts</h2>
      {shifts.length === 0 ? (
        <div className="empty">No shifts logged yet.</div>
      ) : (
        <div className="card table-card">
          <table className="data-table">
            <thead>
              <tr><th>Rep</th><th>Started</th><th>Duration</th><th>Doors</th><th>Status</th></tr>
            </thead>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.id}>
                  <td>{s.userName || s.userId}</td>
                  <td className="muted">{fmt(s.startAt)}</td>
                  <td>{dur(s)}</td>
                  <td>{s.doorsKnocked ?? 0}</td>
                  <td><span className={`badge ${s.status === "active" ? "" : "disabled"}`}>{s.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
