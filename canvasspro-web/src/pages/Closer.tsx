import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDocs, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { APPT_LABEL, APPT_COLOR } from "../lib/closerDispositions";
import CloserDispositionModal from "../components/CloserDispositionModal";
import type { ScheduleEvent, UserStats } from "../types";

const rate = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

const fmt = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function Closer() {
  const { profile, role, companyId } = useAuth();
  const isManager = role === "admin" || role === "manager";
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [team, setTeam] = useState<UserStats[]>([]);
  const [active, setActive] = useState<ScheduleEvent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profile) return;
    // Single-field equality query → no composite index needed; sort client-side.
    const unsub = onSnapshot(
      query(collection(db, "events"), where("closerUid", "==", profile.uid)),
      (snap) => {
        setEvents(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ScheduleEvent, "id">) })));
        setLoading(false);
      },
      (e) => { console.error("closer events", e); setLoading(false); }
    );
    return unsub;
  }, [profile]);

  useEffect(() => {
    if (!profile) return;
    return onSnapshot(doc(db, "userStats", profile.uid), (snap) =>
      setStats(snap.exists() ? ({ uid: snap.id, ...(snap.data() as Omit<UserStats, "uid">) }) : null)
    );
  }, [profile]);

  // Manager/admin roll-up: the closers under this person's closer chain.
  // Admins see every closer in the company.
  useEffect(() => {
    if (!profile || !companyId || !isManager) return;
    (async () => {
      try {
        const base = collection(db, "userStats");
        const q = role === "admin"
          ? query(base, where("companyId", "==", companyId))
          : query(base, where("companyId", "==", companyId), where("closerManagerPath", "array-contains", profile.uid));
        const snap = await getDocs(q);
        const rows = snap.docs
          .map((d) => ({ uid: d.id, ...(d.data() as Omit<UserStats, "uid">) }))
          .filter((r) => (r.closerAppts ?? 0) > 0 || (r.closerSits ?? 0) > 0 || (r.closerCloses ?? 0) > 0);
        setTeam(rows.sort((a, b) => (b.closerCloses ?? 0) - (a.closerCloses ?? 0)));
      } catch (err) {
        console.warn("closer team roll-up failed (index building?)", err);
      }
    })();
  }, [profile, companyId, role, isManager]);

  const { queue, worked } = useMemo(() => {
    const appts = events.filter((e) => e.type === "appointment");
    const isOpen = (e: ScheduleEvent) => !e.apptStatus || e.apptStatus === "scheduled";
    return {
      queue: appts.filter(isOpen).sort((a, b) => a.startAt - b.startAt),
      worked: appts.filter((e) => !isOpen(e)).sort((a, b) => (b.dispositionedAt ?? b.startAt) - (a.dispositionedAt ?? a.startAt)),
    };
  }, [events]);

  const sits = stats?.closerSits ?? 0;
  const closes = stats?.closerCloses ?? 0;
  const closeRate = sits > 0 ? `${Math.round((closes / sits) * 100)}%` : "—";

  const teamTotals = useMemo(() => {
    return team.reduce(
      (acc, r) => ({
        sits: acc.sits + (r.closerSits ?? 0),
        closes: acc.closes + (r.closerCloses ?? 0),
        noShows: acc.noShows + (r.closerNoShows ?? 0),
      }),
      { sits: 0, closes: 0, noShows: 0 }
    );
  }, [team]);

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>🤝 Closer</h1>
        <p className="page-sub">Appointments routed to you — disposition each one on-site.</p>
      </div>

      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <div className="stat-card"><div className="stat-value">{stats?.closerAppts ?? 0}</div><div className="stat-label">Assigned</div><div className="muted small">all-time</div></div>
        <div className="stat-card"><div className="stat-value">{sits}</div><div className="stat-label">Sits</div><div className="muted small">pitched</div></div>
        <div className="stat-card"><div className="stat-value">{closes}</div><div className="stat-label">Closes</div><div className="muted small">won deals</div></div>
        <div className="stat-card"><div className="stat-value">{closeRate}</div><div className="stat-label">Close rate</div><div className="muted small">closes ÷ sits</div></div>
      </div>

      <h2 className="section-h">Your queue</h2>
      {loading ? (
        <p className="muted small">Loading appointments…</p>
      ) : queue.length === 0 ? (
        <div className="empty">No appointments to close right now. New ones land here the moment a setter books them. 🚪→🤝</div>
      ) : (
        <div className="lb-list">
          {queue.map((e) => (
            <div key={e.id} className="lb-row card" style={{ alignItems: "center" }}>
              <div className="lb-row-main">
                <div className="lb-row-top">
                  <span className="lb-row-name">{e.title || e.address || "Appointment"}</span>
                  <span className="muted small">{fmt(e.startAt)}</span>
                </div>
                <div className="muted small">
                  {e.address ? `${e.address} · ` : ""}set by {e.setterName || "a setter"}
                </div>
                {e.notes && <div className="muted small" style={{ marginTop: 4 }}>📝 {e.notes}</div>}
              </div>
              <button className="btn primary sm" onClick={() => setActive(e)}>Disposition</button>
            </div>
          ))}
        </div>
      )}

      {worked.length > 0 && (
        <>
          <h2 className="section-h" style={{ marginTop: 22 }}>Recently worked</h2>
          <div className="lb-list">
            {worked.slice(0, 25).map((e) => (
              <div key={e.id} className="lb-row card" style={{ alignItems: "center" }}>
                <div className="lb-row-main">
                  <div className="lb-row-top">
                    <span className="lb-row-name">{e.title || e.address || "Appointment"}</span>
                    <span
                      className="badge"
                      style={{ background: APPT_COLOR[e.apptStatus || "scheduled"], color: "#06121f", fontWeight: 700 }}
                    >
                      {APPT_LABEL[e.apptStatus || "scheduled"]}
                    </span>
                  </div>
                  <div className="muted small">
                    {e.dispositionedAt ? fmt(e.dispositionedAt) : fmt(e.startAt)}
                    {e.dispositionVerified === false ? " · off-site" : ""}
                  </div>
                  {e.apptNotes && <div className="muted small" style={{ marginTop: 4 }}>📝 {e.apptNotes}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {isManager && team.length > 0 && (
        <>
          <h2 className="section-h" style={{ marginTop: 24 }}>
            {role === "admin" ? "Company closers" : "Your closer team"}
          </h2>
          <div className="stat-grid" style={{ marginBottom: 12 }}>
            <div className="stat-card"><div className="stat-value">{team.length}</div><div className="stat-label">Closers</div></div>
            <div className="stat-card"><div className="stat-value">{teamTotals.closes}</div><div className="stat-label">Closes</div><div className="muted small">{teamTotals.sits} sits</div></div>
            <div className="stat-card"><div className="stat-value">{rate(teamTotals.closes, teamTotals.sits)}</div><div className="stat-label">Team close rate</div></div>
            <div className="stat-card"><div className="stat-value">{teamTotals.noShows}</div><div className="stat-label">No-shows</div><div className="muted small">off-site dispositions</div></div>
          </div>
          <div className="lb-list">
            {team.map((r) => (
              <div key={r.uid} className="lb-row card" style={{ alignItems: "center" }}>
                <div className="lb-row-main">
                  <div className="lb-row-top">
                    <span className="lb-row-name">{r.userName || r.uid}</span>
                    <span className="muted small">{rate(r.closerCloses ?? 0, r.closerSits ?? 0)} close</span>
                  </div>
                  <div className="muted small">
                    {r.closerCloses ?? 0} closed · {r.closerSits ?? 0} sat · {r.closerAppts ?? 0} assigned
                    {(r.closerNoShows ?? 0) > 0 ? ` · ${r.closerNoShows} no-show${r.closerNoShows === 1 ? "" : "s"}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <CloserDispositionModal event={active} onClose={() => setActive(null)} />
    </div>
  );
}
