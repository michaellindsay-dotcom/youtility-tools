import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { bumpStats } from "../lib/stats";
import type { Shift } from "../types";

const IDLE_MS = 30 * 60 * 1000; // auto-END the working shift after 30 idle minutes

interface ShiftState {
  active: Shift | null;
  elapsedSec: number;
  doors: number;
  starting: boolean;
  startShift: () => Promise<void>;
  stopShift: () => Promise<void>;
  recordKnock: (verified: boolean) => Promise<void>;
  bumpActivity: () => void;
  // A shift was auto-ended for inactivity and the rep is active again — prompt
  // them to start a new one. Cleared when they start a shift or dismiss it.
  resumePrompt: boolean;
  dismissResumePrompt: () => void;
}

const Ctx = createContext<ShiftState | undefined>(undefined);

export function ShiftProvider({ children }: { children: ReactNode }) {
  const { profile, companyId } = useAuth();
  const [active, setActive] = useState<Shift | null>(null);
  const [now, setNow] = useState(Date.now());
  const [starting, setStarting] = useState(false);
  const lastActivity = useRef(Date.now());
  const activeRef = useRef<Shift | null>(null);
  activeRef.current = active;
  // Set when a shift is auto-ended for inactivity; drives the "start a new
  // shift?" prompt once the rep interacts with the app again.
  const idleEnded = useRef(false);
  const [resumePrompt, setResumePrompt] = useState(false);

  // Subscribe to my current active shift (enforces a single source of truth).
  useEffect(() => {
    if (!profile) { setActive(null); return; }
    const q = query(
      collection(db, "shifts"),
      where("userId", "==", profile.uid),
      where("status", "==", "active"),
      limit(1)
    );
    return onSnapshot(q, (snap) =>
      setActive(snap.empty ? null : ({ id: snap.docs[0].id, ...(snap.docs[0].data() as Omit<Shift, "id">) }))
    );
  }, [profile]);

  // 1-second ticker for the live timer.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Track user activity for the inactivity auto-stop. If a shift was just
  // auto-ended for idle and the rep is interacting again, surface the prompt.
  useEffect(() => {
    const mark = () => {
      lastActivity.current = Date.now();
      if (idleEnded.current && !activeRef.current) setResumePrompt(true);
    };
    window.addEventListener("pointerdown", mark);
    window.addEventListener("keydown", mark);
    return () => {
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
    };
  }, []);

  // Inactivity check: end the working shift after 30 idle minutes (the rep
  // stays logged in — we just stop the shift and prompt to resume later).
  useEffect(() => {
    const t = setInterval(() => {
      if (activeRef.current && Date.now() - lastActivity.current > IDLE_MS) {
        idleEnded.current = true;
        void stopShift();
      }
    }, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Heartbeat: while the app is open AND recently used, persist a throttled
  // last-activity time so the server's stale-shift closer knows this shift is
  // alive. If the app is closed/backgrounded the heartbeat stops, and the
  // server auto-ends the shift after 30 idle minutes.
  useEffect(() => {
    const t = setInterval(() => {
      const a = activeRef.current;
      if (a && Date.now() - lastActivity.current <= IDLE_MS) {
        void updateDoc(doc(db, "shifts", a.id), { lastActivityAt: Date.now() }).catch(() => {});
      }
    }, 2 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  async function startShift() {
    // Starting a shift clears any pending "resume?" prompt from an idle-out.
    idleEnded.current = false;
    setResumePrompt(false);
    if (activeRef.current || !profile || !companyId) return;
    setStarting(true);
    try {
      // Guard against a race / duplicate active shift.
      const existing = await getDocs(
        query(collection(db, "shifts"), where("userId", "==", profile.uid), where("status", "==", "active"), limit(1))
      );
      if (!existing.empty) return;
      await addDoc(collection(db, "shifts"), {
        companyId,
        userId: profile.uid,
        userName: profile.displayName,
        visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
        status: "active",
        startAt: Date.now(),
        lastActivityAt: Date.now(),
        doorsKnocked: 0,
      });
      lastActivity.current = Date.now();
    } finally {
      setStarting(false);
    }
  }

  async function stopShift() {
    const a = activeRef.current;
    if (!a) return;
    await updateDoc(doc(db, "shifts", a.id), { status: "ended", endAt: Date.now() });
    if (profile) void bumpStats(profile, { shifts: 1, doorsKnocked: a.doorsKnocked ?? 0 });
  }

  // A verified door knock during a shift bumps the shift's door count.
  async function recordKnock(verified: boolean) {
    lastActivity.current = Date.now();
    const a = activeRef.current;
    if (!a || !verified) return;
    await updateDoc(doc(db, "shifts", a.id), { doorsKnocked: increment(1), lastActivityAt: Date.now() }).catch(() => {});
  }

  const elapsedSec = active ? Math.max(0, Math.floor((now - active.startAt) / 1000)) : 0;

  const dismissResumePrompt = () => { idleEnded.current = false; setResumePrompt(false); };

  const value: ShiftState = {
    active,
    elapsedSec,
    doors: active?.doorsKnocked ?? 0,
    starting,
    startShift,
    stopShift,
    recordKnock,
    bumpActivity: () => (lastActivity.current = Date.now()),
    resumePrompt,
    dismissResumePrompt,
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      {resumePrompt && createPortal(
        <div className="shift-resume-toast" role="alert">
          <span>⏸️ Your shift was ended after 30 minutes of inactivity.</span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary sm" disabled={starting} onClick={() => void startShift()}>
              ▶ Start shift
            </button>
            <button className="btn ghost sm" onClick={dismissResumePrompt}>Dismiss</button>
          </div>
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useShift(): ShiftState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useShift must be used within <ShiftProvider>");
  return c;
}

export function fmtElapsed(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
