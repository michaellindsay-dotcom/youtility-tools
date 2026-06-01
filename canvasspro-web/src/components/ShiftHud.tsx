import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { useShift, fmtElapsed } from "../shift/ShiftContext";
import type { Lead } from "../types";

const MIN_PER_DOOR = 2.5; // rough pace → estimated time left to finish the day
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

// The bottom-left map widget. Off shift: a Start Shift button. On shift: a live
// HUD counting elapsed time + what's LEFT today on your success path (doors,
// appointments, and estimated time to hit goal).
export default function ShiftHud() {
  const { profile } = useAuth();
  const { active, elapsedSec, starting, startShift, stopShift } = useShift();
  const [doorsToday, setDoorsToday] = useState(0);
  const [apptToday, setApptToday] = useState(0);
  const [goals, setGoals] = useState({ doorsDay: 100, apptDay: 3 });

  // Daily goals come from the rep's Goal Planner (saved locally).
  useEffect(() => {
    if (!profile) return;
    try {
      const g = localStorage.getItem(`yk_goals_${profile.uid}`);
      if (g) {
        const j = JSON.parse(g);
        setGoals({ doorsDay: j.doorsDay ?? 100, apptDay: j.apptDay ?? 3 });
      }
    } catch { /* defaults */ }
  }, [profile]);

  // Today's verified knocks + appointments (live, only while on shift).
  useEffect(() => {
    if (!profile || !active) return;
    const q = query(
      collection(db, "leads"),
      where("assignedTo", "==", profile.uid),
      where("createdAt", ">=", startOfToday())
    );
    return onSnapshot(q, (snap) => {
      const leads = snap.docs.map((d) => d.data() as Lead).filter((l) => l.verified !== false);
      setDoorsToday(leads.length);
      setApptToday(leads.filter((l) => l.status === "appointment").length);
    });
  }, [profile, active]);

  if (!active) {
    return (
      <button className="map-shift-btn" onClick={() => startShift()} disabled={starting}>
        ▶ {starting ? "Starting…" : "Start Shift"}
      </button>
    );
  }

  const doorsLeft = Math.max(0, goals.doorsDay - doorsToday);
  const apptsLeft = Math.max(0, goals.apptDay - apptToday);
  const mins = Math.ceil(doorsLeft * MIN_PER_DOOR);
  const timeLeft = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  const done = doorsLeft === 0 && apptsLeft === 0;

  return (
    <div className="map-shift-hud">
      <div className="hud-top">
        <span className="hud-live"><span className="pulse-dot" />{fmtElapsed(elapsedSec)}</span>
        <button className="hud-stop" onClick={() => stopShift()}>Stop</button>
      </div>
      <div className="hud-goals">
        <div className="hud-goal"><span className="hud-n">{doorsLeft}</span><span className="hud-lbl">doors left</span></div>
        <div className="hud-goal"><span className="hud-n">{apptsLeft}</span><span className="hud-lbl">appts left</span></div>
        <div className="hud-goal"><span className="hud-n">{done ? "✓" : `~${timeLeft}`}</span><span className="hud-lbl">{done ? "goal hit!" : "to goal"}</span></div>
      </div>
    </div>
  );
}
