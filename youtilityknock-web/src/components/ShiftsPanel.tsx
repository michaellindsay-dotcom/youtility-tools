import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { useShift, fmtElapsed } from "../shift/ShiftContext";
import type { Lead, Shift } from "../types";

// Appointment / close day attribution for the daily breakdown.
const knockTime = (l: Lead) => l.knockedAt || l.createdAt || 0;
const closeTime = (l: Lead) => l.soldAt || l.updatedAt || l.knockedAt || l.createdAt || 0;

// In the phone app a rep only sees their OWN shifts, rolled up one row per day
// for the last 30 days. The web/manager console keeps the per-shift downline
// list (managers reviewing their team) — we'll organize that further later.
const native = Capacitor.isNativePlatform();
const DAYS_BACK = 30;
const WEEKS_BACK = 4;

function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
// Monday-start week (matches the rest of the app's weekly windows).
function startOfWeekMs(ms: number) {
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Shift clock + recent-shifts table. Rendered at the bottom of the Success
// Planner screen, beneath the goal planner and team leaderboard.
export default function ShiftsPanel() {
  const { profile, role, companyId } = useAuth();
  const { active, elapsedSec, doors, starting, startShift, stopShift } = useShift();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]); // team leads (4 wks) for appt/close per day
  // Manager drill-down: rep → last 4 weeks → that week's days.
  const [selRep, setSelRep] = useState<string | null>(null);
  const [selWeek, setSelWeek] = useState<number | null>(null);

  useEffect(() => {
    if (!profile || !companyId) return;
    const base = collection(db, "shifts");
    let q;
    if (native) {
      // The rep's own shifts over the last 30 days. No orderBy in the query
      // (equality + range only) — we sort/aggregate client-side.
      const since = startOfDay(Date.now() - (DAYS_BACK - 1) * 86400000);
      q = query(base, where("userId", "==", profile.uid), where("startAt", ">=", since));
    } else {
      // Manager/web: the team's shifts over the last 4 weeks, for the drill-down.
      const since = startOfWeekMs(Date.now()) - (WEEKS_BACK - 1) * 7 * 86400000;
      q = role === "admin"
        ? query(base, where("companyId", "==", companyId), where("startAt", ">=", since), orderBy("startAt", "desc"))
        : query(base, where("companyId", "==", companyId), where("visibilityPath", "array-contains", profile.uid), where("startAt", ">=", since), orderBy("startAt", "desc"));
    }
    return onSnapshot(q, (snap) => setShifts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Shift, "id">) }))));
  }, [profile, role, companyId]);

  // Team leads over the last 4 weeks — to count appointments & closes per day in
  // the manager drill-down. (Manager/web only.)
  useEffect(() => {
    if (native || !profile || !companyId) return;
    const since = startOfWeekMs(Date.now()) - (WEEKS_BACK - 1) * 7 * 86400000;
    const base = collection(db, "leads");
    const q = role === "admin"
      ? query(base, where("companyId", "==", companyId), where("createdAt", ">=", since))
      : query(base, where("companyId", "==", companyId), where("visibilityPath", "array-contains", profile.uid), where("createdAt", ">=", since));
    getDocs(q)
      .then((snap) => setLeads(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Lead, "id">) }))))
      .catch((e) => console.warn("team leads", e));
  }, [profile, role, companyId]);

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

  // ── Manager drill-down: team → rep → last 4 weeks → that week's days ──────
  const weekStarts = useMemo(() => {
    const cur = startOfWeekMs(Date.now());
    return Array.from({ length: WEEKS_BACK }, (_, i) => cur - i * 7 * 86400000); // newest first
  }, []);

  // Level 0 — every rep in the downline, with days worked (distinct shift days).
  const reps = useMemo(() => {
    if (native) return [];
    const byRep = new Map<string, { uid: string; name: string; ms: number; days: Set<number> }>();
    for (const s of shifts) {
      const row = byRep.get(s.userId) ?? { uid: s.userId, name: s.userName || s.userId, ms: 0, days: new Set<number>() };
      row.ms += durMs(s); row.days.add(startOfDay(s.startAt));
      if (s.userName) row.name = s.userName;
      byRep.set(s.userId, row);
    }
    return [...byRep.values()]
      .map((r) => ({ uid: r.uid, name: r.name, ms: r.ms, daysWorked: r.days.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [shifts]);

  // Level 1 — the selected rep's totals for each of the last 4 weeks.
  const repWeeks = useMemo(() => {
    if (!selRep) return [];
    const mine = shifts.filter((s) => s.userId === selRep);
    return weekStarts.map((ws) => {
      const inWeek = mine.filter((s) => startOfWeekMs(s.startAt) === ws);
      return {
        week: ws,
        ms: inWeek.reduce((t, s) => t + durMs(s), 0),
        doors: inWeek.reduce((t, s) => t + (s.doorsKnocked ?? 0), 0),
        daysWorked: new Set(inWeek.map((s) => startOfDay(s.startAt))).size,
      };
    });
  }, [selRep, shifts, weekStarts]);

  // Level 2 — that week's days for the selected rep: time, doors (shifts), plus
  // appointments & closes (leads). Worked or productive days only.
  const weekDays = useMemo(() => {
    if (!selRep || selWeek == null) return [];
    const byDay = new Map<number, { day: number; ms: number; doors: number; appts: number; closes: number }>();
    const row = (k: number) => {
      let r = byDay.get(k);
      if (!r) { r = { day: k, ms: 0, doors: 0, appts: 0, closes: 0 }; byDay.set(k, r); }
      return r;
    };
    for (const s of shifts) {
      if (s.userId !== selRep || startOfWeekMs(s.startAt) !== selWeek) continue;
      const r = row(startOfDay(s.startAt));
      r.ms += durMs(s); r.doors += s.doorsKnocked ?? 0;
    }
    for (const l of leads) {
      if (l.assignedTo !== selRep) continue;
      if (l.status === "appointment") {
        const k = startOfDay(knockTime(l));
        if (startOfWeekMs(k) === selWeek) row(k).appts += 1;
      }
      if (l.status === "sold") {
        const k = startOfDay(closeTime(l));
        if (startOfWeekMs(k) === selWeek) row(k).closes += 1;
      }
    }
    return [...byDay.values()].sort((a, b) => a.day - b.day);
  }, [selRep, selWeek, shifts, leads]);

  const weekLabel = (ms: number) =>
    ms === startOfWeekMs(Date.now()) ? "This week" : `Week of ${new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const selRepName = reps.find((r) => r.uid === selRep)?.name || "";

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
          <h2 className="section-h">Team shifts <span className="muted small" style={{ fontWeight: 400 }}>· last 4 weeks</span></h2>

          {/* Breadcrumb back through the drill-down. */}
          {(selRep || selWeek != null) && (
            <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <button className="btn ghost sm" onClick={() => { setSelRep(null); setSelWeek(null); }}>← Team</button>
              {selRep && <span className="muted small">{selRepName}</span>}
              {selWeek != null && (
                <>
                  <span className="muted small">›</span>
                  <button className="btn ghost sm" onClick={() => setSelWeek(null)}>{weekLabel(selWeek)}</button>
                </>
              )}
            </div>
          )}

          {/* Level 0 — reps in the downline. */}
          {!selRep && (
            reps.length === 0 ? (
              <div className="empty">No shifts logged in the last 4 weeks.</div>
            ) : (
              <div className="card table-card">
                <table className="data-table">
                  <thead><tr><th>Rep</th><th>Days worked</th><th>Time (4 wks)</th><th></th></tr></thead>
                  <tbody>
                    {reps.map((r) => (
                      <tr key={r.uid} style={{ cursor: "pointer" }} onClick={() => { setSelRep(r.uid); setSelWeek(null); }}>
                        <td>{r.name}</td><td>{r.daysWorked}</td><td>{fmtDur(r.ms)}</td><td className="muted">›</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {/* Level 1 — the rep's last 4 weeks. */}
          {selRep && selWeek == null && (
            <div className="card table-card">
              <table className="data-table">
                <thead><tr><th>Week</th><th>Days</th><th>Time</th><th>Doors</th><th></th></tr></thead>
                <tbody>
                  {repWeeks.map((w) => (
                    <tr key={w.week} style={{ cursor: "pointer" }} onClick={() => setSelWeek(w.week)}>
                      <td>{weekLabel(w.week)}</td><td>{w.daysWorked}</td><td>{fmtDur(w.ms)}</td><td>{w.doors}</td><td className="muted">›</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Level 2 — that week's days (day name header + numeric date). */}
          {selRep && selWeek != null && (
            weekDays.length === 0 ? (
              <div className="empty">No shifts that week.</div>
            ) : (
              <div className="card table-card">
                <table className="data-table">
                  <thead><tr><th>Day</th><th>Time</th><th>Doors</th><th>Appts</th><th>Closes</th></tr></thead>
                  <tbody>
                    {weekDays.map((d) => (
                      <tr key={d.day}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{new Date(d.day).toLocaleDateString(undefined, { weekday: "long" })}</div>
                          <div className="muted small">{new Date(d.day).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })}</div>
                        </td>
                        <td>{fmtDur(d.ms)}</td><td>{d.doors}</td><td>{d.appts}</td><td>{d.closes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}
    </>
  );
}
