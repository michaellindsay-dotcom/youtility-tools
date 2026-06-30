import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { Link } from "react-router-dom";
import CalendarBanner from "../components/CalendarBanner";
import CalendarView from "../components/CalendarView";
import { APPT_LABEL, APPT_COLOR } from "../lib/closerDispositions";
import type { EventType, ScheduleEvent } from "../types";

const META: Record<EventType, { label: string; icon: string }> = {
  appointment: { label: "Appointment", icon: "📅" },
  go_back: { label: "Go-back", icon: "↩" },
  follow_up: { label: "Follow-up", icon: "🔁" },
};

export default function Schedule() {
  const { profile, role, companyId } = useAuth();
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  // Appointments this user SET that were routed out to a closer (they don't
  // appear in the agenda above, which is keyed on the closer as the owner).
  const [routed, setRouted] = useState<ScheduleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | EventType>("all");
  const [range, setRange] = useState<"day" | "week" | "month">("week");
  const [assignee, setAssignee] = useState<string>("all");

  useEffect(() => {
    if (!profile || !companyId) return;
    // Own events + (for managers/admins) downstream via visibilityPath.
    const q =
      role === "admin" || role === "manager"
        ? query(
            collection(db, "events"),
            where("companyId", "==", companyId),
            where("visibilityPath", "array-contains", profile.uid),
            orderBy("startAt", "asc")
          )
        : query(collection(db, "events"), where("userId", "==", profile.uid), orderBy("startAt", "asc"));
    return onSnapshot(
      q,
      (snap) => {
        setEvents(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ScheduleEvent, "id">) })));
        setLoading(false);
      },
      (err) => {
        console.error("events query", err);
        setLoading(false);
      }
    );
  }, [profile, role, companyId]);

  // Appointments I set that were routed to a closer (single-field query → no
  // composite index). Shown in their own section with the closer + outcome.
  useEffect(() => {
    if (!profile) return;
    return onSnapshot(
      query(collection(db, "events"), where("setterUid", "==", profile.uid)),
      (snap) => setRouted(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ScheduleEvent, "id">) }))),
      (err) => console.error("routed appts query", err)
    );
  }, [profile]);

  const isMgr = role === "admin" || role === "manager";
  // Appointments I set for someone else to close (exclude self-assigned).
  const routedOut = routed
    .filter((e) => e.closerUid && e.closerUid !== profile?.uid)
    .sort((a, b) => b.startAt - a.startAt);
  // Distinct assignees seen in the agenda (managers/admins can filter by rep).
  const assignees = isMgr
    ? Array.from(new Map(events.filter((e) => e.userId).map((e) => [e.userId, e.userName || e.userId])).entries())
    : [];
  // Events to show on the calendar (filtered by type + assignee; the calendar
  // owns its own date navigation, so no time window here).
  const visible = events.filter((e) =>
    (filter === "all" || e.type === filter) &&
    (assignee === "all" || e.userId === assignee)
  );

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Schedule</h1>
        <p className="page-sub">
          Your appointments, go-backs and follow-ups. You'll get an alert before each one.
        </p>
      </div>

      <CalendarBanner />

      {routedOut.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>🤝 Appointments you set</h3>
          <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>
            Routed to a closer — here's where each one stands.
          </p>
          <ul className="sched-list">
            {routedOut.map((e) => (
              <li key={e.id} className="sched-item">
                <span className="sched-ico">🤝</span>
                <div className="sched-body">
                  <div className="sched-title">
                    {e.title || e.address || "Appointment"}
                    <span className="role-badge" style={{ background: APPT_COLOR[e.apptStatus || "scheduled"], color: "#06121f" }}>
                      {APPT_LABEL[e.apptStatus || "scheduled"]}
                    </span>
                  </div>
                  <div className="muted small">
                    {new Date(e.startAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {e.closerName ? ` · closer: ${e.closerName}` : ""}
                  </div>
                  {e.apptNotes && <div className="muted small">📝 {e.apptNotes}</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="type-pills" style={{ marginBottom: 10 }}>
        {(["day", "week", "month"] as const).map((r) => (
          <button
            key={r}
            className={"pill" + (range === r ? " active" : "")}
            onClick={() => setRange(r)}
          >
            {r === "day" ? "Day" : r === "week" ? "Week" : "Month"}
          </button>
        ))}
      </div>

      <div className="type-pills" style={{ marginBottom: 10, alignItems: "center", gap: 8 }}>
        {(["all", "appointment", "go_back", "follow_up"] as const).map((t) => (
          <button
            key={t}
            className={"pill" + (filter === t ? " active" : "")}
            onClick={() => setFilter(t)}
          >
            {t === "all" ? "All" : `${META[t].icon} ${META[t].label}`}
          </button>
        ))}
        {isMgr && assignees.length > 0 && (
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            style={{ marginLeft: "auto" }}
            title="Filter by who it's assigned to"
          >
            <option value="all">👤 Everyone</option>
            {assignees.map(([uid, name]) => (
              <option key={uid} value={uid}>{name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 18 }}>📍</span>
        <div className="muted small">
          New appointments, go-backs and follow-ups are booked while you're at the home —
          from the <Link to="/map">Map</Link> or <Link to="/leads">Leads</Link> screen. This page is your agenda.
        </div>
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : (
        <CalendarView events={visible} view={range} canHearRecording={isMgr} />
      )}
    </div>
  );
}
