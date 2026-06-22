import { useEffect, useMemo, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { useShift, fmtElapsed } from "../shift/ShiftContext";
import type { Shift } from "../types";

// In the phone app a rep only sees their OWN shifts, rolled up one row per day
// for the last 30 days. The web/manager console keeps the per-shift downline
// list (managers reviewing their team) — we'll organize that further later.
const native = Capacitor.isNativePlatform();
const DAYS_BACK = 30;

function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Shift clock + recent-shifts table. Rendered at the bottom of the Success
// Planner screen, beneath the goal planner and team leaderboard.
export default function ShiftsPanel() {
  const { profile, role, companyId } = useAuth();
  const { active, elapsedSec, doors, starting, startShift, stopShift } = useShift();
  const [shifts, setShifts] = useState<Shift[]>([]);

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "shifts");
    let q;
    if (native) {
      // The rep's own shifts over the last 30 days. No orderBy in the query
      // (equality + range only) — we sort/aggregate client-side.
      const since = startOfDay(Date.now() - (DAYS_BACK - 1) * 86400000);
      q = query(base, where("userId", "==", profile.uid), where("startAt", ">=", since));
    } else if (role === "admin") {
      q = query(base, where("companyId", "==", companyId), orderBy("startAt", "desc"), limit(50));
    } else {
      q = query(
        base,
        where("companyId", "==", companyId),
        where("visibilityPath", "array-contains", profile.uid),
        orderBy("startAt", "desc"),
        limit(50)
      );
    }
    return onSnapshot(q, (snap) => setShifts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Shift, "id">) }))));
  }, [profile, role, companyId]);

  const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleString() : "—");
  const durMs = (s: Shift) => (s.endAt ?? Date.now()) - s.startAt;
  const fmtDur = (ms: number) => {
    const mins = Math.round(ms / 60000);
    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  };

  // Roll the rep's shifts up to one row per calendar day (newest first).
  const days = useMemo(() => {
    if (!native) return [];
    const byDay = new Map<number, { day: number; count: number; ms: number; doors: number }>();
    for (const s of shifts) {
      const key = startOfDay(s.startAt);
      const row = byDay.get(key) ?? { day: key, count: 0, ms: 0, doors: 0 };
      row.count += 1;
      row.ms += durMs(s);
      row.doors += s.doorsKnocked ?? 0;
      byDay.set(key, row);
    }
    return [...byDay.values()].sort((a, b) => b.day - a.day);
  }, [shifts]);

  const dayLabel = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

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

      {native ? (
        <>
          <h2 className="section-h">Your last 30 days</h2>
          {days.length === 0 ? (
            <div className="empty">No shifts logged yet.</div>
          ) : (
            <div className="card table-card">
              <table className="data-table">
                <thead>
                  <tr><th>Day</th><th>Shifts</th><th>Time</th><th>Doors</th></tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.day}>
                      <td>{dayLabel(d.day)}</td>
                      <td>{d.count}</td>
                      <td>{fmtDur(d.ms)}</td>
                      <td>{d.doors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
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
                      <td>{fmtDur(durMs(s))}</td>
                      <td>{s.doorsKnocked ?? 0}</td>
                      <td><span className={`badge ${s.status === "active" ? "" : "disabled"}`}>{s.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
