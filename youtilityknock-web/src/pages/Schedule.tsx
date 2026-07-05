import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { Link } from "react-router-dom";
import { isRallyCardOnly } from "../lib/features";
import CalendarBanner from "../components/CalendarBanner";
import CalendarView from "../components/CalendarView";
import type { EventType, ScheduleEvent } from "../types";

const META: Record<EventType, { label: string; icon: string }> = {
  appointment: { label: "Appointment", icon: "📅" },
  go_back: { label: "Go-back", icon: "↩" },
  follow_up: { label: "Follow-up", icon: "🔁" },
};

export default function Schedule() {
  const { profile, role, companyId, company } = useAuth();
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  // Appointments this user SET that were routed out to a closer (they don't
  // appear in the agenda above, which is keyed on the closer as the owner).
  const [routed, setRouted] = useState<ScheduleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | EventType>("all");
  const [range, setRange] = useState<"day" | "week" | "month">("week");
  const [assignee, setAssignee] = useState<string>("all");
  // Two-way sync (inbound): the viewer's own external-calendar busy blocks,
  // so anything blocked in Google/Outlook shows as busy here too.
  const [busy, setBusy] = useState<{ start: number; end: number }[]>([]);

  useEffect(() => {
    if (!profile) return;
    const now = Date.now();
    httpsCallable(functions, "myExternalBusy")({ startMs: now - 7 * 86400000, endMs: now + 45 * 86400000 })
      .then((r) => setBusy((((r.data as { busy?: { start: number; end: number }[] })?.busy) || []).filter((b) => b.start && b.end)))
      .catch(() => setBusy([]));
  }, [profile]);

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
  // My calendar feed = events I can see (mine, or my downline via visibilityPath
  // for managers) MERGED with appointments I personally SET that were routed to
  // a closer — so a setter sees their booked appointments and the closer they
  // went to, even though the closer owns them. Deduped by id. This is scoped to
  // "mine or my downline" — never the whole company.
  const feed = (() => {
    const byId = new Map<string, ScheduleEvent>();
    for (const e of events) byId.set(e.id, e);
    for (const e of routed) if (!byId.has(e.id)) byId.set(e.id, e);
    return Array.from(byId.values());
  })();
  // Distinct assignees seen in the feed (managers/admins can filter by rep).
  const assignees = isMgr
    ? Array.from(new Map(feed.filter((e) => e.userId).map((e) => [e.userId, e.userName || e.userId])).entries())
    : [];
  // Events to show on the calendar (filtered by type + assignee; the calendar
  // owns its own date navigation, so no time window here).
  const visible = feed.filter((e) =>
    (filter === "all" || e.type === filter) &&
    (assignee === "all" || e.userId === assignee || e.closerUid === assignee)
  );

  return (
    <div className="page-body">
      <div className="page-head">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <h1>Schedule</h1>
          {/* RallyCard-only companies have no Dashboard to go back to. */}
          {!isRallyCardOnly(company) && (
            <Link className="btn ghost sm" to="/">← Back to Dashboard</Link>
          )}
        </div>
        <p className="page-sub">
          Your appointments, go-backs and follow-ups. You'll get an alert before each one.
        </p>
      </div>

      <CalendarBanner />

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
        <CalendarView
          events={visible}
          busy={busy}
          view={range}
          canHearRecording={isMgr}
          me={profile ? { uid: profile.uid, displayName: profile.displayName || "" } : null}
          companyId={companyId}
        />
      )}
    </div>
  );
}
