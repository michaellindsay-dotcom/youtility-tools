import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { isDispositionOverdue } from "../lib/closerDispositions";
import CloserDispositionModal from "./CloserDispositionModal";
import type { ScheduleEvent } from "../types";

const isNative = Capacitor.isNativePlatform();

// Hard gate for closers: the moment a closer opens the app (native or web), if
// any of their appointments are past-due and still not dispositioned — with a
// 2-hour grace buffer after the scheduled end, in case the appointment ran long —
// they're blocked from everything until they record an outcome for each one.
// Un-dispositioned appointments strand setters (they never learn what happened)
// and understate the whole team's production, so this is deliberately unskippable.
export default function CloserDispositionGate() {
  const { profile, role } = useAuth();
  const gated = profile?.isCloser === true && role !== "admin";
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [active, setActive] = useState<ScheduleEvent | null>(null);
  // Ids we've just dispositioned — dropped from the list immediately so the gate
  // updates with no delay, without waiting for the Firestore listener to catch up.
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());

  // Live subscription to this closer's appointments (single-field query — no
  // composite index needed; same one the dashboard nag uses).
  useEffect(() => {
    if (!gated || !profile?.uid) { setEvents([]); return; }
    const unsub = onSnapshot(
      query(collection(db, "events"), where("closerUid", "==", profile.uid)),
      (snap) => setEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ScheduleEvent)),
      (err) => console.warn("disposition gate: events subscribe failed", err)
    );
    return () => unsub();
  }, [gated, profile?.uid]);

  // Advance "now" so an appointment that crosses its 2-hour grace while the app
  // is already open starts gating; also re-check when the app returns to front.
  const bump = useCallback(() => setNow(Date.now()), []);
  useEffect(() => {
    if (!gated) return;
    const iv = window.setInterval(bump, 60000);
    let remove: (() => void) | undefined;
    if (isNative) {
      App.addListener("appStateChange", ({ isActive }) => { if (isActive) bump(); })
        .then((h) => { remove = () => h.remove(); });
    }
    const onVis = () => { if (document.visibilityState === "visible") bump(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearInterval(iv); remove?.(); document.removeEventListener("visibilitychange", onVis); };
  }, [gated, bump]);

  const overdue = useMemo(
    () => events.filter((e) => !cleared.has(e.id) && isDispositionOverdue(e, now)).sort((a, b) => a.startAt - b.startAt),
    [events, now, cleared]
  );

  if (!gated || overdue.length === 0) return null;

  // The disposition modal draws its own full-screen overlay, so while it's open
  // we render it alone (it covers the app just as the gate does). Closing it
  // without recording an outcome simply drops back to the gate.
  if (active) {
    const doneId = active.id;
    return (
      <CloserDispositionModal
        event={active}
        afterTheFact
        onClose={() => setActive(null)}
        onDone={() => {
          // Drop it from the list right away; if it was the last one the gate
          // returns null on the next render and the closer lands on the dashboard.
          setCleared((prev) => new Set(prev).add(doneId));
          setActive(null);
          bump();
        }}
      />
    );
  }

  const fmt = (ms: number) =>
    new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return createPortal(
    <div style={overlay}>
      <div style={card}>
        <div style={{ fontSize: 40 }}>📋</div>
        <h2 style={{ margin: "8px 0 6px", fontFamily: "'Space Grotesk', sans-serif" }}>
          Close out your appointments
        </h2>
        <p style={{ color: "#b6c2d6", fontSize: 14, lineHeight: 1.5, margin: 0 }}>
          You have {overdue.length} past-due appointment{overdue.length === 1 ? "" : "s"} that {overdue.length === 1 ? "hasn't" : "haven't"} been
          dispositioned. Record the outcome for each one to keep using the app — your setters and your team's numbers depend on it.
        </p>
        <div style={list}>
          {overdue.map((e) => (
            <button key={e.id} style={row} onClick={() => setActive(e)}>
              <div style={{ textAlign: "left", minWidth: 0, flex: 1 }}>
                <div style={rowTitle}>{e.title || e.address || "Appointment"}</div>
                <div style={rowSub}>
                  {fmt(e.startAt)}{e.address && e.title ? ` · ${e.address}` : ""}
                </div>
              </div>
              <span style={cta}>Disposition →</span>
            </button>
          ))}
        </div>
        <p style={{ color: "#8a97ad", fontSize: 12, lineHeight: 1.5, margin: "14px 0 0" }}>
          You get a 2-hour buffer after each appointment's end time before it lands here.
        </p>
      </div>
    </div>,
    document.body
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 4000,
  background: "radial-gradient(120% 90% at 50% 0%, #14233f 0%, #0a0f1a 60%, #080b12 100%)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "max(20px, env(safe-area-inset-top)) 22px max(20px, env(safe-area-inset-bottom))",
  textAlign: "center",
  color: "#f4f7fb",
  overflowY: "auto",
};
const card: React.CSSProperties = { width: "100%", maxWidth: 420 };
const list: React.CSSProperties = {
  marginTop: 18,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  maxHeight: "50vh",
  overflowY: "auto",
};
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  background: "rgba(255,255,255,.05)",
  border: "1px solid rgba(255,255,255,.12)",
  borderRadius: 12,
  padding: "12px 14px",
  cursor: "pointer",
  color: "#f4f7fb",
  fontFamily: "inherit",
};
const rowTitle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const rowSub: React.CSSProperties = {
  color: "#8a97ad",
  fontSize: 12,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const cta: React.CSSProperties = {
  flex: "0 0 auto",
  color: "#38BDF8",
  fontWeight: 700,
  fontSize: 13,
};
