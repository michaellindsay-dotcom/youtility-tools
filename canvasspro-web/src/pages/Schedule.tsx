import { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { EventType, ScheduleEvent } from "../types";

const TYPES: { value: EventType; label: string; icon: string }[] = [
  { value: "appointment", label: "Appointment", icon: "📅" },
  { value: "go_back", label: "Go-back", icon: "↩" },
  { value: "follow_up", label: "Follow-up", icon: "🔁" },
];

// datetime-local helpers (local time, no seconds).
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

export default function Schedule() {
  const { profile, role, companyId, company } = useAuth();
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [type, setType] = useState<EventType>("appointment");
  const [title, setTitle] = useState("");
  const [address, setAddress] = useState("");
  const [when, setWhen] = useState(toLocalInput(Date.now() + 60 * 60 * 1000));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [autoAssign, setAutoAssign] = useState(false);
  const [assignMsg, setAssignMsg] = useState("");

  // Admins/managers can auto-route appointments when the company isn't self-gen.
  const canAssign =
    (role === "admin" || role === "manager") &&
    !!company?.scheduling &&
    company.scheduling.assignment !== "self_gen";

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
        : query(
            collection(db, "events"),
            where("userId", "==", profile.uid),
            orderBy("startAt", "asc")
          );
    return onSnapshot(
      q,
      (snap) => setEvents(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ScheduleEvent, "id">) }))),
      (err) => console.error("events query", err)
    );
  }, [profile, role, companyId]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!profile || !companyId || !title.trim()) return;
    setSaving(true);
    setAssignMsg("");
    try {
      // Appointment + auto-assign → route to an available rep via company policy.
      if (type === "appointment" && canAssign && autoAssign) {
        const r = await httpsCallable(functions, "assignAppointment")({
          companyId,
          startAt: new Date(when).getTime(),
          title: title.trim(),
          address: address.trim() || "",
          notes: notes.trim() || "",
        });
        const data = r.data as { assignedName?: string };
        setAssignMsg(`Assigned to ${data.assignedName || "an available rep"} ✓`);
      } else {
        await addDoc(collection(db, "events"), {
          companyId,
          userId: profile.uid,
          userName: profile.displayName,
          type,
          title: title.trim(),
          address: address.trim() || "",
          startAt: new Date(when).getTime(),
          durationMin: company?.scheduling?.apptDurationMin ?? 60,
          endAt: new Date(when).getTime() + (company?.scheduling?.apptDurationMin ?? 60) * 60000,
          source: "self_gen",
          notes: notes.trim() || "",
          visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
          reminded: false,
          createdAt: Date.now(),
        });
      }
      setTitle("");
      setAddress("");
      setNotes("");
    } catch (err) {
      setAssignMsg((err as Error).message || "Couldn't save the event.");
    } finally {
      setSaving(false);
    }
  }

  const now = Date.now();
  const upcoming = events.filter((e) => e.startAt >= now - 60 * 60 * 1000);
  const past = events.filter((e) => e.startAt < now - 60 * 60 * 1000).reverse();

  const meta = (t: EventType) => TYPES.find((x) => x.value === t)!;
  const fmt = (ms: number) =>
    new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const row = (e: ScheduleEvent) => (
    <li key={e.id} className="sched-item">
      <span className="sched-ico">{meta(e.type).icon}</span>
      <div className="sched-body">
        <div className="sched-title">
          {e.title}
          <span className="role-badge">{meta(e.type).label}</span>
        </div>
        <div className="muted small">
          {fmt(e.startAt)}
          {e.address ? ` · ${e.address}` : ""}
          {role !== "user" && e.userId !== profile?.uid && e.userName ? ` · ${e.userName}` : ""}
        </div>
        {e.notes && <div className="muted small">{e.notes}</div>}
      </div>
      {(e.userId === profile?.uid || role === "admin" || role === "manager") && (
        <button
          className="btn ghost sm"
          onClick={() => deleteDoc(doc(db, "events", e.id)).catch(() => {})}
          title="Delete"
        >
          ✕
        </button>
      )}
    </li>
  );

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Schedule</h1>
        <p className="page-sub">Appointments, go-backs and follow-ups. You'll get an alert before each one.</p>
      </div>

      <div className="sched-grid">
        <form className="card sched-form" onSubmit={add}>
          <h3>New event</h3>
          <div className="type-pills">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                className={"pill" + (type === t.value ? " active" : "")}
                onClick={() => setType(t.value)}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Demo with the Smiths" required />
          </label>
          <label className="field">
            <span>Address</span>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" />
          </label>
          <label className="field">
            <span>When</span>
            <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          {canAssign && type === "appointment" && (
            <label className="dispo-sched-toggle" style={{ marginBottom: 4 }}>
              <input type="checkbox" checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} />
              <span>
                Auto-assign to an available rep ({company!.scheduling!.assignment.replace("_", " ")})
              </span>
            </label>
          )}
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : autoAssign ? "Assign appointment" : "Add to schedule"}
          </button>
          {assignMsg && <div className="muted small">{assignMsg}</div>}
        </form>

        <div className="sched-lists">
          <h3>Upcoming</h3>
          {upcoming.length === 0 ? (
            <div className="empty">Nothing scheduled.</div>
          ) : (
            <ul className="sched-list">{upcoming.map(row)}</ul>
          )}
          {past.length > 0 && (
            <>
              <h3 style={{ marginTop: 18 }}>Past</h3>
              <ul className="sched-list past">{past.slice(0, 25).map(row)}</ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
