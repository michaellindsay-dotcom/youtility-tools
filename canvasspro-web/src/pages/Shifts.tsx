import { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { bumpStats } from "../lib/stats";
import type { Shift } from "../types";

export default function Shifts() {
  const { profile, role, companyId } = useAuth();
  const [active, setActive] = useState<Shift | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [busy, setBusy] = useState(false);

  // Watch my current active shift.
  useEffect(() => {
    if (!profile) return;
    const q = query(
      collection(db, "shifts"),
      where("userId", "==", profile.uid),
      where("status", "==", "active"),
      limit(1)
    );
    return onSnapshot(q, (snap) => {
      setActive(snap.empty ? null : ({ id: snap.docs[0].id, ...(snap.docs[0].data() as Omit<Shift, "id">) }));
    });
  }, [profile]);

  // Recent shifts: mine + downstream (admins: whole company).
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
    return onSnapshot(q, (snap) =>
      setShifts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Shift, "id">) })))
    );
  }, [profile, role, companyId]);

  const startShift = async () => {
    if (!profile || !companyId) return;
    setBusy(true);
    try {
      await addDoc(collection(db, "shifts"), {
        companyId,
        userId: profile.uid,
        userName: profile.displayName,
        visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
        status: "active",
        startAt: Date.now(),
        doorsKnocked: 0,
      });
    } finally {
      setBusy(false);
    }
  };

  const knock = async () => {
    if (!active) return;
    await updateDoc(doc(db, "shifts", active.id), { doorsKnocked: increment(1) });
  };

  const endShift = async () => {
    if (!active || !profile) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, "shifts", active.id), { status: "ended", endAt: Date.now() });
      void bumpStats(profile, { shifts: 1, doorsKnocked: active.doorsKnocked ?? 0 });
    } finally {
      setBusy(false);
    }
  };

  const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleString() : "—");
  const dur = (s: Shift) => {
    const end = s.endAt ?? Date.now();
    const mins = Math.round((end - s.startAt) / 60000);
    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  };

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Shifts</h1>
        <p className="page-sub">Clock your canvassing time and doors knocked.</p>
      </div>

      <div className="card shift-control">
        {active ? (
          <>
            <div>
              <div className="shift-live">● On shift — {dur(active)}</div>
              <div className="muted">Doors knocked: <strong>{active.doorsKnocked ?? 0}</strong></div>
            </div>
            <div className="row">
              <button className="btn" onClick={knock}>+1 door</button>
              <button className="btn primary" onClick={endShift} disabled={busy}>End shift</button>
            </div>
          </>
        ) : (
          <>
            <div className="muted">You're not on a shift.</div>
            <button className="btn primary" onClick={startShift} disabled={busy}>Start shift</button>
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
                  <td>
                    <span className={`badge ${s.status === "active" ? "" : "disabled"}`}>{s.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
