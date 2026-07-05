import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { APPT_LABEL, APPT_COLOR, isSit, isCloserAppt, wasOnSpot } from "../lib/closerDispositions";
import CloserDispositionModal from "../components/CloserDispositionModal";
import type { ScheduleEvent } from "../types";

interface CloserRow { uid: string; name: string; assigned: number; sits: number; closes: number; noShows: number; weekPast: number; weekNot: number }
// Company-wide "not dispositioned on the spot" tallies, past appointments only.
interface OnSpotAgg { dayPast: number; dayNot: number; weekPast: number; weekNot: number }

const rate = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
function startOfTodayMs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeekMs() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }

const fmt = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function Closer() {
  const { profile, role, companyId } = useAuth();
  const navigate = useNavigate();
  const isManager = role === "admin" || role === "manager";
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [team, setTeam] = useState<CloserRow[]>([]);
  const [onSpot, setOnSpot] = useState<OnSpotAgg>({ dayPast: 0, dayNot: 0, weekPast: 0, weekNot: 0 });
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

  // Manager/admin roll-up: aggregate the team's appointment EVENTS by closer
  // (the source of truth), so the numbers match each closer's own view. Admins
  // see the whole company; managers see their downline via visibilityPath.
  // Re-runs when this closer's own events change (e.g. after a disposition).
  useEffect(() => {
    if (!profile || !companyId || !isManager) return;
    const base = collection(db, "events");
    const q = role === "admin"
      ? query(base, where("companyId", "==", companyId))
      : query(base, where("companyId", "==", companyId), where("visibilityPath", "array-contains", profile.uid));
    getDocs(q).then((snap) => {
      const byCloser = new Map<string, CloserRow>();
      const now = Date.now();
      const dayStart = startOfTodayMs();
      const weekStart = startOfWeekMs();
      const agg: OnSpotAgg = { dayPast: 0, dayNot: 0, weekPast: 0, weekNot: 0 };
      snap.docs.forEach((d) => {
        const e = { id: d.id, ...(d.data() as Omit<ScheduleEvent, "id">) };
        if (!isCloserAppt(e) || !e.closerUid) return;
        const row = byCloser.get(e.closerUid) ?? { uid: e.closerUid, name: e.closerName || "Closer", assigned: 0, sits: 0, closes: 0, noShows: 0, weekPast: 0, weekNot: 0 };
        row.assigned++;
        if (isSit(e.apptStatus)) row.sits++;
        if (e.apptStatus === "closed_won") row.closes++;
        if (e.apptStatus === "closer_no_show") row.noShows++;
        if (e.closerName) row.name = e.closerName;
        // "Not dispositioned on the spot" — only appointments whose time has
        // passed count (a future appt hasn't happened yet). Not on the spot =
        // dispositioned late (after the fact) OR still not dispositioned at all.
        if (e.startAt < now) {
          const notOnSpot = !wasOnSpot(e);
          if (e.startAt >= weekStart) {
            agg.weekPast++; row.weekPast++;
            if (notOnSpot) { agg.weekNot++; row.weekNot++; }
          }
          if (e.startAt >= dayStart) {
            agg.dayPast++;
            if (notOnSpot) agg.dayNot++;
          }
        }
        byCloser.set(e.closerUid, row);
      });
      setTeam([...byCloser.values()].sort((a, b) => b.closes - a.closes));
      setOnSpot(agg);
    }).catch((err) => console.warn("closer team roll-up", err));
  }, [profile, companyId, role, isManager, events.length]);

  const { queue, worked } = useMemo(() => {
    const appts = events.filter((e) => e.type === "appointment");
    const isOpen = (e: ScheduleEvent) => !e.apptStatus || e.apptStatus === "scheduled";
    return {
      queue: appts.filter(isOpen).sort((a, b) => a.startAt - b.startAt),
      worked: appts.filter((e) => !isOpen(e)).sort((a, b) => (b.dispositionedAt ?? b.startAt) - (a.dispositionedAt ?? a.startAt)),
    };
  }, [events]);

  // Derive the closer's own stats from the LIVE appointment events (the source
  // of truth) rather than rolled-up counters that can drift — so a close or
  // sit recorded just now shows immediately and accurately.
  const myAppts = useMemo(() => events.filter((e) => e.type === "appointment"), [events]);
  const assigned = myAppts.length;
  const sits = useMemo(() => myAppts.filter((e) => isSit(e.apptStatus)).length, [myAppts]);
  const closes = useMemo(() => myAppts.filter((e) => e.apptStatus === "closed_won").length, [myAppts]);
  const closeRate = sits > 0 ? `${Math.round((closes / sits) * 100)}%` : "—";
  // The closer's own on-the-spot ratio: of their past appointments, how many
  // they closed out at the door (vs late / still open).
  const myPast = useMemo(() => myAppts.filter((e) => e.startAt < Date.now()), [myAppts]);
  const myOnSpot = useMemo(() => myPast.filter((e) => wasOnSpot(e)).length, [myPast]);
  const onSpotRate = rate(myOnSpot, myPast.length);

  const teamTotals = useMemo(() => {
    return team.reduce(
      (acc, r) => ({ sits: acc.sits + r.sits, closes: acc.closes + r.closes, noShows: acc.noShows + r.noShows }),
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
        <div className="stat-card"><div className="stat-value">{assigned}</div><div className="stat-label">Assigned</div><div className="muted small">appointments</div></div>
        <div className="stat-card"><div className="stat-value">{sits}</div><div className="stat-label">Sits</div><div className="muted small">pitched</div></div>
        <div className="stat-card"><div className="stat-value">{closes}</div><div className="stat-label">Closes</div><div className="muted small">won deals</div></div>
        <div className="stat-card"><div className="stat-value">{closeRate}</div><div className="stat-label">Close rate</div><div className="muted small">closes ÷ sits</div></div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: myPast.length > 0 && myOnSpot < myPast.length ? "#fbbf24" : undefined }}>{onSpotRate}</div>
          <div className="stat-label">On the spot</div>
          <div className="muted small">{myOnSpot} of {myPast.length} dispositioned at the door</div>
        </div>
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
                {e.incentives && e.incentives.length > 0 && (
                  <details className="muted small" style={{ marginTop: 4 }}>
                    <summary>⚡ {e.incentives.length} area incentive{e.incentives.length === 1 ? "" : "s"}{e.incentivesUtility?.name ? ` · ${e.incentivesUtility.name}` : ""}</summary>
                    <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 4 }}>
                      {e.incentives.map((i, idx) => (
                        <div key={idx} style={{ borderLeft: "2px solid #34D399", paddingLeft: 8 }}>
                          <strong>{i.name}</strong>{i.amount ? ` — ${i.amount}` : ""}
                          {i.url && <> · <a href={i.url} target="_blank" rel="noreferrer">verify ↗</a></>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" title="Build a battery proposal for this appointment" onClick={() => navigate(`/battery?eventId=${e.id}`)}>🔋 Proposal</button>
                <button className="btn primary sm" onClick={() => setActive(e)}>Disposition</button>
              </div>
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

      {isManager && (onSpot.weekPast > 0 || onSpot.dayPast > 0) && (
        <>
          <h2 className="section-h" style={{ marginTop: 24 }}>Dispositioned on the spot</h2>
          <p className="muted small" style={{ marginTop: -6, marginBottom: 10 }}>
            Share of past appointments that weren't closed out at the door — either logged late (after the fact) or still open.
          </p>
          <div className="stat-grid" style={{ marginBottom: 12 }}>
            <div className="stat-card">
              <div className="stat-value" style={{ color: onSpot.dayNot > 0 ? "#f87171" : undefined }}>{rate(onSpot.dayNot, onSpot.dayPast)}</div>
              <div className="stat-label">Not on-spot · today</div>
              <div className="muted small">{onSpot.dayNot} of {onSpot.dayPast}</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: onSpot.weekNot > 0 ? "#f87171" : undefined }}>{rate(onSpot.weekNot, onSpot.weekPast)}</div>
              <div className="stat-label">Not on-spot · this week</div>
              <div className="muted small">{onSpot.weekNot} of {onSpot.weekPast}</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{rate(onSpot.weekPast - onSpot.weekNot, onSpot.weekPast)}</div>
              <div className="stat-label">On-spot · this week</div>
              <div className="muted small">{onSpot.weekPast - onSpot.weekNot} of {onSpot.weekPast}</div>
            </div>
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
                    <span className="lb-row-name">{r.name}</span>
                    <span className="muted small">{rate(r.closes, r.sits)} close</span>
                  </div>
                  <div className="muted small">
                    {r.closes} closed · {r.sits} sat · {r.assigned} assigned
                    {r.noShows > 0 ? ` · ${r.noShows} no-show${r.noShows === 1 ? "" : "s"}` : ""}
                    {r.weekPast > 0 ? ` · ${rate(r.weekNot, r.weekPast)} not on-spot this wk` : ""}
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
