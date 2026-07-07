import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { addDoc, collection, doc, getDocs, limit, orderBy, query, setDoc, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import { db, storage, functions } from "../firebase";
import { APPT_LABEL } from "../lib/closerDispositions";
import CloserDispositionModal from "./CloserDispositionModal";
import type { ScheduleEvent } from "../types";

type View = "day" | "week" | "month";
type Me = { uid: string; displayName: string; isManager?: boolean } | null;
type Busy = { start: number; end: number };
// Drag/edit capability threaded down to each event Block.
type EditCtx = {
  canEdit: (e: ScheduleEvent) => boolean;
  onEdit: (e: ScheduleEvent) => void;
  onDragStart: (e: ScheduleEvent) => void;
};
const DAY = 86_400_000;
const HOUR_START = 6;   // 6 AM
const HOUR_END = 21;    // 9 PM (inclusive row)
const HOURS = Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => HOUR_START + i);
const PALETTE = ["#0EA5E9", "#8B5CF6", "#F59E0B", "#10B981", "#F472B6", "#34D399", "#FB923C", "#60A5FA", "#A78BFA", "#F87171"];

function startOfDay(ms: number): number { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeek(ms: number): number { const d = new Date(startOfDay(ms)); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }
function startOfMonth(ms: number): number { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); }
function sameDay(a: number, b: number): boolean { return startOfDay(a) === startOfDay(b); }
// Stable color per assignee (closer takes precedence, else the rep).
function colorFor(e: ScheduleEvent): string {
  const key = e.closerUid || e.userId || e.userName || "?";
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function assigneeName(e: ScheduleEvent): string { return e.closerName || e.userName || "Unassigned"; }
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
// An appointment routed to a closer that the closer hasn't dispositioned yet
// (still "scheduled" / blank). Overdue = its time has passed and it's still open.
function isUndispositioned(e: ScheduleEvent): boolean {
  return e.type === "appointment" && !!e.closerUid && (!e.apptStatus || e.apptStatus === "scheduled");
}
function isOverdue(e: ScheduleEvent): boolean {
  return isUndispositioned(e) && e.startAt < Date.now();
}

// Phone-sized layout: the 7-column hourly week grid and text-filled month cells
// don't fit, so we switch to an agenda list / dot grid below this width.
function useNarrow(): boolean {
  const [n, setN] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 720px)");
    const h = () => setN(m.matches);
    m.addEventListener?.("change", h);
    return () => m.removeEventListener?.("change", h);
  }, []);
  return n;
}

// Does an external busy block overlap the [dayStart+h, +1h] cell?
function hourBusy(busy: Busy[], dayStart: number, h: number): boolean {
  const s = dayStart + h * 3_600_000;
  const e = s + 3_600_000;
  return busy.some((b) => b.start < e && s < b.end);
}
// Any busy block on this calendar day?
function dayBusy(busy: Busy[], dayStart: number): boolean {
  const e = dayStart + DAY;
  return busy.some((b) => b.start < e && dayStart < b.end);
}
// A translucent "external busy" band shown inside an hour cell.
function BusyBlock() {
  return (
    <div title="Busy — blocked on your external calendar"
      style={{ background: "repeating-linear-gradient(45deg,rgba(148,163,184,.28),rgba(148,163,184,.28) 6px,rgba(148,163,184,.12) 6px,rgba(148,163,184,.12) 12px)", border: "1px solid rgba(148,163,184,.5)", borderRadius: 5, padding: "2px 6px", marginBottom: 3, fontSize: 10, color: "#cbd5e1", lineHeight: 1.2 }}>
      🔒 Busy
    </div>
  );
}

export default function CalendarView({
  events, busy = [], view, canHearRecording, me, companyId,
}: {
  events: ScheduleEvent[];
  busy?: Busy[];
  view: View;
  canHearRecording: boolean;
  me: Me;
  companyId: string | null;
}) {
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [selected, setSelected] = useState<ScheduleEvent | null>(null);
  // The closer can close out a past appointment straight from the calendar.
  const [dispoTarget, setDispoTarget] = useState<ScheduleEvent | null>(null);
  // Edit (date/closer) target + the currently-dragged appointment.
  const [editTarget, setEditTarget] = useState<ScheduleEvent | null>(null);
  const dragRef = useRef<ScheduleEvent | null>(null);
  const narrow = useNarrow();

  // The original setter, or a manager/admin for the team, may edit/reschedule.
  const canEdit = (e: ScheduleEvent) =>
    e.type === "appointment" && !!me && (!!me.isManager || e.setterUid === me.uid);

  // Drop an appointment onto a new day/hour → reschedule it there (keeping its
  // original minute-of-hour). Server enforces the same permission.
  async function rescheduleTo(e: ScheduleEvent, dayStart: number, hour: number) {
    const mins = new Date(e.startAt).getMinutes();
    const newStart = dayStart + hour * 3_600_000 + mins * 60_000;
    if (Math.abs(newStart - e.startAt) < 60_000) return; // no meaningful move
    try {
      await httpsCallable(functions, "rescheduleAppointment")({ eventId: e.id, startAt: newStart });
    } catch (err) {
      alert((err as Error)?.message || "Couldn't reschedule the appointment.");
    }
  }
  const edit: EditCtx = {
    canEdit,
    onEdit: (e) => setEditTarget(e),
    onDragStart: (e) => { dragRef.current = e; },
  };
  const onDropAt = (dayStart: number, hour: number) => {
    const e = dragRef.current;
    dragRef.current = null;
    if (e && canEdit(e)) void rescheduleTo(e, dayStart, hour);
  };

  // Reset the anchor to today whenever the view mode changes.
  useEffect(() => { setAnchor(startOfDay(Date.now())); }, [view]);

  const step = (dir: 1 | -1) => {
    const d = new Date(anchor);
    if (view === "day") d.setDate(d.getDate() + dir);
    else if (view === "week") d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setAnchor(startOfDay(d.getTime()));
  };
  const openDay = (ms: number) => { setAnchor(startOfDay(ms)); /* caller flips to day via header */ };

  const title = useMemo(() => {
    const d = new Date(anchor);
    if (view === "day") return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    if (view === "week") {
      const s = new Date(startOfWeek(anchor)); const e = new Date(startOfWeek(anchor) + 6 * DAY);
      return `${s.toLocaleDateString([], { month: "short", day: "numeric" })} – ${e.toLocaleDateString([], { month: "short", day: "numeric" })}`;
    }
    return d.toLocaleDateString([], { month: "long", year: "numeric" });
  }, [anchor, view]);

  return (
    <div className="calendar-view">
      <div className="row between" style={{ alignItems: "center", marginBottom: 10 }}>
        <button type="button" className="btn ghost sm" onClick={() => step(-1)}>‹</button>
        <strong style={{ flex: 1, textAlign: "center" }}>{title}</strong>
        <button type="button" className="btn ghost sm" onClick={() => setAnchor(startOfDay(Date.now()))}>Today</button>
        <button type="button" className="btn ghost sm" onClick={() => step(1)}>›</button>
      </div>

      {view === "day" && <DayGrid dayMs={anchor} events={events} busy={busy} onPick={setSelected} edit={edit} onDropAt={onDropAt} />}
      {view === "week" && (narrow
        ? <WeekAgenda weekMs={startOfWeek(anchor)} events={events} busy={busy} onPick={setSelected} edit={edit} />
        : <WeekGrid weekMs={startOfWeek(anchor)} events={events} busy={busy} onPick={setSelected} onOpenDay={openDay} edit={edit} onDropAt={onDropAt} />)}
      {view === "month" && <MonthGrid monthMs={startOfMonth(anchor)} events={events} busy={busy} onPick={setSelected} onOpenDay={openDay} narrow={narrow} edit={edit} />}

      {selected && (
        <EventPopout
          ev={selected}
          canHearRecording={canHearRecording}
          me={me}
          companyId={companyId}
          edit={edit}
          onClose={() => setSelected(null)}
          onDisposition={(e) => { setSelected(null); setDispoTarget(e); }}
        />
      )}

      {/* After-the-fact close-out, opened from the popout by the assigned closer. */}
      <CloserDispositionModal
        event={dispoTarget}
        afterTheFact
        onClose={() => setDispoTarget(null)}
      />

      {/* Setter / manager / admin edit: change date-time or reassign the closer. */}
      {editTarget && (
        <EditAppointmentModal event={editTarget} onClose={() => setEditTarget(null)} />
      )}
    </div>
  );
}

// Change an appointment's date/time and/or reassign its closer. Shown when the
// setter, a manager, or an admin double-clicks the block. Both edits go through
// the server, which re-checks permission and keeps the external calendar in sync.
function EditAppointmentModal({ event, onClose }: { event: ScheduleEvent; onClose: () => void }) {
  const [when, setWhen] = useState(() => toLocalInput(event.startAt));
  const [closerUid, setCloserUid] = useState(event.closerUid || "");
  const [closers, setClosers] = useState<{ uid: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await httpsCallable(functions, "listClosers")({});
        const list = ((res.data as { closers?: { uid: string; name: string }[] })?.closers) || [];
        if (!cancelled) setClosers(list);
      } catch { /* leave dropdown with just the current closer */ }
    })();
    return () => { cancelled = true; };
  }, []);

  async function cancelAppt() {
    setErr(null);
    if (!confirm("Cancel this appointment? It's removed from the calendar and from everyone's appointment stats. This can't be undone.")) return;
    setSaving(true);
    try {
      await httpsCallable(functions, "cancelAppointment")({ eventId: event.id });
      onClose();
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't cancel the appointment.");
      setSaving(false);
    }
  }

  async function save() {
    setErr(null);
    const newStart = new Date(when).getTime();
    if (!Number.isFinite(newStart)) { setErr("Pick a valid date and time."); return; }
    const dateChanged = Math.abs(newStart - event.startAt) >= 60_000;
    const closerChanged = !!closerUid && closerUid !== (event.closerUid || "");
    if (!dateChanged && !closerChanged) { onClose(); return; }
    setSaving(true);
    try {
      if (dateChanged) {
        await httpsCallable(functions, "rescheduleAppointment")({ eventId: event.id, startAt: newStart });
      }
      if (closerChanged) {
        await httpsCallable(functions, "reassignAppointment")({ eventId: event.id, closerUid });
      }
      onClose();
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't save the changes.");
      setSaving(false);
    }
  }

  // Make sure the current closer is always an option even if listClosers is slow.
  const options = closers.some((c) => c.uid === closerUid) || !closerUid
    ? closers
    : [{ uid: closerUid, name: event.closerName || "Current closer" }, ...closers];

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(2,8,18,.6)", display: "grid", placeItems: "center", zIndex: 1100, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: 420, width: "100%", background: "var(--bg-2)", border: "1px solid #2a3a55", boxShadow: "0 24px 60px rgba(0,0,0,.55)" }}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <h3 style={{ margin: 0 }}>Edit appointment</h3>
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="muted small" style={{ marginTop: 4 }}>{event.title || "Appointment"}</div>

        <label className="muted small" style={{ display: "block", marginTop: 12, marginBottom: 4 }}>Date &amp; time</label>
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          style={{ width: "100%", borderRadius: 8, padding: 8, background: "#0b1727", color: "#e6eef8", border: "1px solid #21314a", fontSize: 14 }}
        />

        <label className="muted small" style={{ display: "block", marginTop: 12, marginBottom: 4 }}>Closer</label>
        <select
          value={closerUid}
          onChange={(e) => setCloserUid(e.target.value)}
          style={{ width: "100%", borderRadius: 8, padding: 8, background: "#0b1727", color: "#e6eef8", border: "1px solid #21314a", fontSize: 14 }}
        >
          <option value="">— Unassigned —</option>
          {options.map((c) => <option key={c.uid} value={c.uid}>{c.name}</option>)}
        </select>

        {err && <div className="muted small" style={{ color: "#fca5a5", marginTop: 10 }}>{err}</div>}

        <div className="row" style={{ justifyContent: "space-between", gap: 8, marginTop: 16, alignItems: "center" }}>
          <button
            className="btn ghost sm"
            onClick={cancelAppt}
            disabled={saving}
            style={{ color: "#fca5a5", borderColor: "rgba(252,165,165,.4)" }}
          >
            🗑 Cancel appointment
          </button>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost sm" onClick={onClose} disabled={saving}>Close</button>
            <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ms → "YYYY-MM-DDTHH:mm" in local time for a datetime-local input.
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// One block shown inside a time cell. An overdue, undispositioned appointment
// gets a red ring + ⚠ so a setter can spot at a glance that the closer hasn't
// recorded an outcome yet.
function Block({ e, onPick, edit }: { e: ScheduleEvent; onPick: (e: ScheduleEvent) => void; edit?: EditCtx }) {
  const overdue = isOverdue(e);
  const canEdit = !!edit?.canEdit(e);
  const navigate = useNavigate();
  // Editors double-click to change the date/closer; everyone else jumps to the
  // full customer history. Editors can also drag the block to a new time slot.
  return (
    <button
      type="button"
      draggable={canEdit}
      onDragStart={canEdit ? (ev) => {
        ev.stopPropagation();
        // Firefox (and some engines) won't start a drag unless dataTransfer is
        // populated in dragstart.
        try { ev.dataTransfer.setData("text/plain", e.id); ev.dataTransfer.effectAllowed = "move"; } catch { /* noop */ }
        edit?.onDragStart(e);
      } : undefined}
      onClick={() => onPick(e)}
      onDoubleClick={() => { if (canEdit) edit?.onEdit(e); else if (e.leadId) navigate(`/lead/${e.leadId}`); }}
      title={`${fmtTime(e.startAt)} · ${e.title} · ${assigneeName(e)}${overdue ? " · ⚠ not dispositioned" : ""}${canEdit ? " · double-click to edit · drag to reschedule" : e.leadId ? " · double-click for full history" : ""}`}
      style={{
        display: "block", width: "100%", textAlign: "left", border: "none", borderRadius: 6,
        padding: "3px 6px", marginBottom: 3, cursor: canEdit ? "grab" : "pointer", color: "#06121f",
        background: colorFor(e), fontSize: 11, lineHeight: 1.25, overflow: "hidden",
        boxShadow: overdue ? "inset 0 0 0 2px #ef4444" : undefined,
      }}
    >
      <strong>{fmtTime(e.startAt)}</strong> {overdue ? "⚠ " : ""}{e.title}
      <div style={{ opacity: 0.85 }}>{assigneeName(e)}</div>
    </button>
  );
}

function DayGrid({ dayMs, events, busy, onPick, edit, onDropAt }: { dayMs: number; events: ScheduleEvent[]; busy: Busy[]; onPick: (e: ScheduleEvent) => void; edit?: EditCtx; onDropAt?: (dayStart: number, hour: number) => void }) {
  const dayEvents = events.filter((e) => sameDay(e.startAt, dayMs)).sort((a, b) => a.startAt - b.startAt);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", border: "1px solid #21314a", borderRadius: 8, overflow: "hidden" }}>
      {HOURS.map((h) => (
        <div key={h} style={{ display: "contents" }}>
          <div style={{ borderTop: "1px solid #21314a", padding: "4px 6px", fontSize: 11, color: "#8aa0b8", textAlign: "right" }}>{hourLabel(h)}</div>
          <div
            onDragOver={onDropAt ? (ev) => ev.preventDefault() : undefined}
            onDrop={onDropAt ? (ev) => { ev.preventDefault(); onDropAt(dayMs, h); } : undefined}
            style={{ borderTop: "1px solid #21314a", borderLeft: "1px solid #21314a", padding: 4, minHeight: 34 }}>
            {hourBusy(busy, dayMs, h) && <BusyBlock />}
            {dayEvents.filter((e) => new Date(e.startAt).getHours() === h).map((e) => <Block key={e.id} e={e} onPick={onPick} edit={edit} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function WeekGrid({ weekMs, events, busy, onPick, onOpenDay, edit, onDropAt }: { weekMs: number; events: ScheduleEvent[]; busy: Busy[]; onPick: (e: ScheduleEvent) => void; onOpenDay: (ms: number) => void; edit?: EditCtx; onDropAt?: (dayStart: number, hour: number) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => weekMs + i * DAY);
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "56px repeat(7, minmax(96px, 1fr))", minWidth: 760, border: "1px solid #21314a", borderRadius: 8 }}>
        <div />
        {days.map((d) => (
          <div key={d} onDoubleClick={() => onOpenDay(d)} title="Double-click to open this day"
            style={{ padding: "6px 4px", textAlign: "center", borderLeft: "1px solid #21314a", cursor: "pointer", background: sameDay(d, Date.now()) ? "rgba(14,165,233,.12)" : undefined }}>
            <div style={{ fontSize: 11, color: "#8aa0b8" }}>{new Date(d).toLocaleDateString([], { weekday: "short" })}</div>
            <div style={{ fontWeight: 700 }}>{new Date(d).getDate()}</div>
          </div>
        ))}
        {HOURS.map((h) => (
          <div key={h} style={{ display: "contents" }}>
            <div style={{ borderTop: "1px solid #21314a", padding: "4px 4px", fontSize: 10, color: "#8aa0b8", textAlign: "right" }}>{hourLabel(h)}</div>
            {days.map((d) => (
              <div key={d}
                onDragOver={onDropAt ? (ev) => ev.preventDefault() : undefined}
                onDrop={onDropAt ? (ev) => { ev.preventDefault(); onDropAt(d, h); } : undefined}
                style={{ borderTop: "1px solid #21314a", borderLeft: "1px solid #21314a", padding: 3, minHeight: 30 }}>
                {hourBusy(busy, d, h) && <BusyBlock />}
                {events.filter((e) => sameDay(e.startAt, d) && new Date(e.startAt).getHours() === h).sort((a, b) => a.startAt - b.startAt).map((e) => <Block key={e.id} e={e} onPick={onPick} edit={edit} />)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// Phone week view: a readable day-by-day agenda instead of the wide hourly grid.
function WeekAgenda({ weekMs, events, busy, onPick, edit }: { weekMs: number; events: ScheduleEvent[]; busy: Busy[]; onPick: (e: ScheduleEvent) => void; edit?: EditCtx }) {
  const days = Array.from({ length: 7 }, (_, i) => weekMs + i * DAY);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {days.map((d) => {
        const dayEvents = events.filter((e) => sameDay(e.startAt, d)).sort((a, b) => a.startAt - b.startAt);
        const isToday = sameDay(d, Date.now());
        const hasBusy = dayBusy(busy, d);
        return (
          <div key={d} style={{ border: "1px solid #21314a", borderRadius: 10, overflow: "hidden", opacity: dayEvents.length ? 1 : 0.7 }}>
            <div style={{ padding: "7px 10px", background: isToday ? "rgba(14,165,233,.16)" : "rgba(255,255,255,.03)", fontSize: 13, fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{new Date(d).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}{isToday ? " · Today" : ""}</span>
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {hasBusy && <span title="Busy on your external calendar" style={{ fontSize: 11 }}>🔒</span>}
                {dayEvents.length > 0 && <span style={{ color: "#8aa0b8", fontSize: 12, fontWeight: 600 }}>{dayEvents.length}</span>}
              </span>
            </div>
            {dayEvents.length > 0 && (
              <div style={{ padding: 8, display: "grid", gap: 4 }}>
                {dayEvents.map((e) => <Block key={e.id} e={e} onPick={onPick} edit={edit} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MonthGrid({ monthMs, events, busy, onPick, onOpenDay, narrow, edit }: { monthMs: number; events: ScheduleEvent[]; busy: Busy[]; onPick: (e: ScheduleEvent) => void; onOpenDay: (ms: number) => void; narrow?: boolean; edit?: EditCtx }) {
  const gridStart = startOfWeek(monthMs);
  const month = new Date(monthMs).getMonth();
  const cells = Array.from({ length: 42 }, (_, i) => gridStart + i * DAY);
  return (
    <div style={{ border: "1px solid #21314a", borderRadius: 8, overflow: "hidden" }}>
      {/* minmax(0,1fr) lets all 7 columns fit the phone — without it the no-wrap
          event text forces the columns wide so only ~3 days show. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((w, i) => (
          <div key={i} style={{ padding: "5px 4px", fontSize: 11, color: "#8aa0b8", textAlign: "center", borderBottom: "1px solid #21314a" }}>{narrow ? w : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i]}</div>
        ))}
        {cells.map((d) => {
          const dayEvents = events.filter((e) => sameDay(e.startAt, d)).sort((a, b) => a.startAt - b.startAt);
          const inMonth = new Date(d).getMonth() === month;
          const busyDay = dayBusy(busy, d);
          return (
            <div key={d} onDoubleClick={() => onOpenDay(d)} title="Double-click to open this day"
              style={{ minHeight: narrow ? 54 : 84, minWidth: 0, borderTop: "1px solid #21314a", borderLeft: "1px solid #21314a", padding: narrow ? 3 : 4, cursor: "pointer", opacity: inMonth ? 1 : 0.4, background: sameDay(d, Date.now()) ? "rgba(14,165,233,.10)" : undefined }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: sameDay(d, Date.now()) ? "#38bdf8" : "#8aa0b8", marginBottom: 2, display: "flex", justifyContent: "space-between" }}>
                <span>{new Date(d).getDate()}</span>
                {busyDay && <span title="Busy on your external calendar">🔒</span>}
              </div>
              {narrow ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignContent: "flex-start" }}>
                  {dayEvents.slice(0, 4).map((e) => (
                    <button key={e.id} type="button" onClick={(ev) => { ev.stopPropagation(); onPick(e); }} title={`${fmtTime(e.startAt)} · ${e.title}`}
                      style={{ width: 9, height: 9, borderRadius: "50%", border: "none", padding: 0, cursor: "pointer", background: colorFor(e) }} />
                  ))}
                  {dayEvents.length > 4 && <span style={{ fontSize: 9, color: "#8aa0b8", lineHeight: "10px" }}>+{dayEvents.length - 4}</span>}
                </div>
              ) : (
                <>
                  {dayEvents.slice(0, 3).map((e) => (
                    <button key={e.id} type="button"
                      onClick={(ev) => { ev.stopPropagation(); onPick(e); }}
                      onDoubleClick={edit?.canEdit(e) ? (ev) => { ev.stopPropagation(); edit.onEdit(e); } : undefined}
                      title={edit?.canEdit(e) ? "Double-click to edit date/closer" : undefined}
                      style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderRadius: 4, padding: "1px 4px", marginBottom: 2, cursor: "pointer", color: "#06121f", background: colorFor(e), fontSize: 10, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                      {fmtTime(e.startAt)} {assigneeName(e)}
                    </button>
                  ))}
                  {dayEvents.length > 3 && <div style={{ fontSize: 10, color: "#8aa0b8" }}>+{dayEvents.length - 3} more</div>}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Pop-out appointment details. For managers, fetches + plays the lead's pitch
// recording so they can hear the door when there aren't written notes. When the
// appointment is routed to a different closer, the viewer can DM that closer to
// chase the outcome — handy when it's overdue and still undispositioned.
function EventPopout({ ev, canHearRecording, me, companyId, edit, onClose, onDisposition }: { ev: ScheduleEvent; canHearRecording: boolean; me: Me; companyId: string | null; edit?: EditCtx; onClose: () => void; onDisposition: (e: ScheduleEvent) => void }) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recState, setRecState] = useState<"idle" | "loading" | "none">(canHearRecording && ev.leadId ? "loading" : "none");
  const undisp = isUndispositioned(ev);
  const overdue = isOverdue(ev);
  // The assigned closer can close out their own still-open appointment right
  // here — from the calendar, after the fact.
  const canDisposition = !!(me && ev.closerUid === me.uid && undisp);
  // Direct-message counterpart: a closer messages the SETTER (questions about the
  // appointment); a setter — or a manager/admin — messages the CLOSER (updates /
  // chase the outcome). Whoever it is, the message tags this appointment.
  const iAmCloser = !!(me && ev.closerUid && me.uid === ev.closerUid);
  const dmTarget: { uid: string; name: string; role: "setter" | "closer" } | null =
    iAmCloser
      ? (ev.setterUid && ev.setterName ? { uid: ev.setterUid, name: ev.setterName, role: "setter" } : null)
      : (ev.closerUid && ev.closerName && ev.closerUid !== me?.uid ? { uid: ev.closerUid, name: ev.closerName, role: "closer" } : null);
  const dateLabel = new Date(ev.startAt).toLocaleDateString([], { month: "short", day: "numeric" });
  const [dmText, setDmText] = useState(
    dmTarget?.role === "setter"
      ? `Hey ${dmTarget.name}, quick question on the ${dateLabel} appointment${ev.title ? ` — ${ev.title}` : ""}: `
      : `Hey ${dmTarget?.name || "there"}, update on the ${dateLabel} appointment${ev.title ? ` — ${ev.title}` : ""}: `
  );
  const [dmState, setDmState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const navigate = useNavigate();

  async function messageCounterpart() {
    if (!me || !dmTarget) return;
    const body = dmText.trim();
    if (!body) return;
    setDmState("sending");
    try {
      const cid = [me.uid, dmTarget.uid].sort().join("__");
      await setDoc(
        doc(db, "dms", cid),
        {
          members: [me.uid, dmTarget.uid],
          memberNames: { [me.uid]: me.displayName, [dmTarget.uid]: dmTarget.name },
          companyId: companyId || "",
          lastMessage: body,
          lastAt: Date.now(),
        },
        { merge: true }
      );
      await addDoc(collection(db, "dms", cid, "messages"), {
        channelId: cid, userId: me.uid, userName: me.displayName, text: body, createdAt: Date.now(),
        // Tag the appointment so it shows as a clickable reference in chat.
        apptEventId: ev.id, apptTitle: ev.title || "Appointment", apptAt: ev.startAt,
        ...(ev.leadId ? { leadId: ev.leadId } : {}),
      });
      setDmState("sent");
    } catch {
      setDmState("error");
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (!(canHearRecording && ev.leadId)) return;
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, "pitches"), where("leadId", "==", ev.leadId), orderBy("createdAt", "desc"), limit(1)));
        if (cancelled) return;
        const path = snap.docs[0]?.data()?.audioPath as string | undefined;
        if (!path) { setRecState("none"); return; }
        const url = await getDownloadURL(storageRef(storage, path));
        if (!cancelled) { setAudioUrl(url); setRecState("idle"); }
      } catch { if (!cancelled) setRecState("none"); }
    })();
    return () => { cancelled = true; };
  }, [canHearRecording, ev.leadId]);

  const fmt = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(2,8,18,.6)", display: "grid", placeItems: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: 440, width: "100%", background: "var(--bg-2)", border: "1px solid #2a3a55", boxShadow: "0 24px 60px rgba(0,0,0,.55)", maxHeight: "90vh", overflowY: "auto" }}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <h3 style={{ margin: 0 }}>{ev.title || "Appointment"}</h3>
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="muted small" style={{ marginTop: 4 }}>{fmt(ev.startAt)}{ev.durationMin ? ` · ${ev.durationMin} min` : ""}</div>

        {/* The setter / a manager / an admin can change the date-time or closer.
            This button is the reliable path on touch devices where drag and
            double-click aren't available. */}
        {edit?.canEdit(ev) && (
          <button className="btn ghost sm" style={{ width: "100%", marginTop: 10 }} onClick={() => { onClose(); edit.onEdit(ev); }}>
            🗓 Reschedule / reassign closer
          </button>
        )}

        {undisp && (
          <div style={{ marginTop: 10, borderRadius: 8, padding: "8px 10px", background: "rgba(239,68,68,.12)", border: "1px solid rgba(239,68,68,.5)", color: "#fecaca", fontSize: 13 }}>
            ⚠ {overdue ? "This appointment is past due and the closer hasn't dispositioned it yet." : "Not dispositioned by the closer yet."}
          </div>
        )}

        {canDisposition && (
          <button className="btn primary" style={{ width: "100%", marginTop: 12 }} onClick={() => onDisposition(ev)}>
            ✍️ Disposition this appointment
          </button>
        )}

        {ev.leadId && (
          <button className="btn ghost sm" style={{ width: "100%", marginTop: 8 }} onClick={() => { onClose(); navigate(`/lead/${ev.leadId}`); }}>
            👁 Open full customer history →
          </button>
        )}

        <dl className="fields" style={{ marginTop: 10 }}>
          <div className="field-row"><dt>Assigned to</dt><dd>👤 {ev.userName || "—"}</dd></div>
          {ev.setterName && <div className="field-row"><dt>Setter</dt><dd>📇 {ev.setterName}</dd></div>}
          {ev.closerName && <div className="field-row"><dt>Closer</dt><dd>🤝 {ev.closerName}</dd></div>}
          {ev.address && <div className="field-row"><dt>Address</dt><dd>{ev.address}</dd></div>}
          <div className="field-row"><dt>Status</dt><dd>{ev.apptStatus ? (APPT_LABEL[ev.apptStatus] || ev.apptStatus) : "Scheduled — awaiting closer"}</dd></div>
        </dl>
        {(ev.notes || ev.apptNotes) && <div className="muted small" style={{ marginTop: 6 }}>📝 {ev.apptNotes || ev.notes}</div>}

        {dmTarget && (
          <div style={{ marginTop: 12, borderTop: "1px solid #21314a", paddingTop: 10 }}>
            <div className="muted small" style={{ marginBottom: 6 }}>
              💬 Message the {dmTarget.role} ({dmTarget.name}){dmTarget.role === "setter" ? " with any questions" : " with an update or question"}
            </div>
            {dmState === "sent" ? (
              <div className="muted small" style={{ color: "#86efac" }}>✓ Sent to {dmTarget.name} — tagged to this appointment. Reply lands in Team Chat → Direct messages.</div>
            ) : (
              <>
                <textarea
                  value={dmText}
                  onChange={(e) => setDmText(e.target.value)}
                  rows={2}
                  style={{ width: "100%", resize: "vertical", borderRadius: 8, padding: 8, background: "#0b1727", color: "#e6eef8", border: "1px solid #21314a", fontSize: 13 }}
                />
                <div className="row" style={{ justifyContent: "space-between", marginTop: 6, gap: 8, alignItems: "center" }}>
                  <span className="muted small" style={{ display: "flex", alignItems: "center", gap: 4 }}>📅 Tagged: {ev.title || "Appointment"}</span>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    {dmState === "error" && <span className="muted small" style={{ color: "#fca5a5" }}>Couldn't send — try again.</span>}
                    <button className="btn primary sm" disabled={dmState === "sending" || !dmText.trim()} onClick={messageCounterpart}>
                      {dmState === "sending" ? "Sending…" : `Send to ${dmTarget.role}`}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {canHearRecording && (
          <div style={{ marginTop: 12, borderTop: "1px solid #21314a", paddingTop: 10 }}>
            <div className="muted small" style={{ marginBottom: 6 }}>🎙️ Door recording {(!ev.notes && !ev.apptNotes) ? "(no written notes — listen in)" : ""}</div>
            {recState === "loading" && <div className="muted small">Loading recording…</div>}
            {recState === "none" && <div className="muted small">No recording for this appointment.</div>}
            {recState === "idle" && audioUrl && <audio controls src={audioUrl} style={{ width: "100%" }} />}
          </div>
        )}
      </div>
    </div>
  );
}
