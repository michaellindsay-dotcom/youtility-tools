import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import { db, storage } from "../firebase";
import { APPT_LABEL } from "../lib/closerDispositions";
import type { ScheduleEvent } from "../types";

type View = "day" | "week" | "month";
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

export default function CalendarView({
  events, view, canHearRecording,
}: {
  events: ScheduleEvent[];
  view: View;
  canHearRecording: boolean;
}) {
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [selected, setSelected] = useState<ScheduleEvent | null>(null);

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

      {view === "day" && <DayGrid dayMs={anchor} events={events} onPick={setSelected} />}
      {view === "week" && <WeekGrid weekMs={startOfWeek(anchor)} events={events} onPick={setSelected} onOpenDay={openDay} />}
      {view === "month" && <MonthGrid monthMs={startOfMonth(anchor)} events={events} onPick={setSelected} onOpenDay={openDay} />}

      {selected && (
        <EventPopout ev={selected} canHearRecording={canHearRecording} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// One block shown inside a time cell.
function Block({ e, onPick }: { e: ScheduleEvent; onPick: (e: ScheduleEvent) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(e)}
      title={`${fmtTime(e.startAt)} · ${e.title} · ${assigneeName(e)}`}
      style={{
        display: "block", width: "100%", textAlign: "left", border: "none", borderRadius: 6,
        padding: "3px 6px", marginBottom: 3, cursor: "pointer", color: "#06121f",
        background: colorFor(e), fontSize: 11, lineHeight: 1.25, overflow: "hidden",
      }}
    >
      <strong>{fmtTime(e.startAt)}</strong> {e.title}
      <div style={{ opacity: 0.85 }}>{assigneeName(e)}</div>
    </button>
  );
}

function DayGrid({ dayMs, events, onPick }: { dayMs: number; events: ScheduleEvent[]; onPick: (e: ScheduleEvent) => void }) {
  const dayEvents = events.filter((e) => sameDay(e.startAt, dayMs)).sort((a, b) => a.startAt - b.startAt);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", border: "1px solid #21314a", borderRadius: 8, overflow: "hidden" }}>
      {HOURS.map((h) => (
        <div key={h} style={{ display: "contents" }}>
          <div style={{ borderTop: "1px solid #21314a", padding: "4px 6px", fontSize: 11, color: "#8aa0b8", textAlign: "right" }}>{hourLabel(h)}</div>
          <div style={{ borderTop: "1px solid #21314a", borderLeft: "1px solid #21314a", padding: 4, minHeight: 34 }}>
            {dayEvents.filter((e) => new Date(e.startAt).getHours() === h).map((e) => <Block key={e.id} e={e} onPick={onPick} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function WeekGrid({ weekMs, events, onPick, onOpenDay }: { weekMs: number; events: ScheduleEvent[]; onPick: (e: ScheduleEvent) => void; onOpenDay: (ms: number) => void }) {
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
              <div key={d} style={{ borderTop: "1px solid #21314a", borderLeft: "1px solid #21314a", padding: 3, minHeight: 30 }}>
                {events.filter((e) => sameDay(e.startAt, d) && new Date(e.startAt).getHours() === h).sort((a, b) => a.startAt - b.startAt).map((e) => <Block key={e.id} e={e} onPick={onPick} />)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthGrid({ monthMs, events, onPick, onOpenDay }: { monthMs: number; events: ScheduleEvent[]; onPick: (e: ScheduleEvent) => void; onOpenDay: (ms: number) => void }) {
  const gridStart = startOfWeek(monthMs);
  const month = new Date(monthMs).getMonth();
  const cells = Array.from({ length: 42 }, (_, i) => gridStart + i * DAY);
  return (
    <div style={{ border: "1px solid #21314a", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => (
          <div key={w} style={{ padding: "5px 6px", fontSize: 11, color: "#8aa0b8", textAlign: "center", borderBottom: "1px solid #21314a" }}>{w}</div>
        ))}
        {cells.map((d) => {
          const dayEvents = events.filter((e) => sameDay(e.startAt, d)).sort((a, b) => a.startAt - b.startAt);
          const inMonth = new Date(d).getMonth() === month;
          return (
            <div key={d} onDoubleClick={() => onOpenDay(d)} title="Double-click to open this day"
              style={{ minHeight: 84, borderTop: "1px solid #21314a", borderLeft: "1px solid #21314a", padding: 4, cursor: "pointer", opacity: inMonth ? 1 : 0.4, background: sameDay(d, Date.now()) ? "rgba(14,165,233,.10)" : undefined }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#8aa0b8", marginBottom: 2 }}>{new Date(d).getDate()}</div>
              {dayEvents.slice(0, 3).map((e) => (
                <button key={e.id} type="button" onClick={(ev) => { ev.stopPropagation(); onPick(e); }}
                  style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderRadius: 4, padding: "1px 4px", marginBottom: 2, cursor: "pointer", color: "#06121f", background: colorFor(e), fontSize: 10, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  {fmtTime(e.startAt)} {assigneeName(e)}
                </button>
              ))}
              {dayEvents.length > 3 && <div style={{ fontSize: 10, color: "#8aa0b8" }}>+{dayEvents.length - 3} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Pop-out appointment details. For managers, fetches + plays the lead's pitch
// recording so they can hear the door when there aren't written notes.
function EventPopout({ ev, canHearRecording, onClose }: { ev: ScheduleEvent; canHearRecording: boolean; onClose: () => void }) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recState, setRecState] = useState<"idle" | "loading" | "none">(canHearRecording && ev.leadId ? "loading" : "none");

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
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: 440, width: "100%" }}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <h3 style={{ margin: 0 }}>{ev.title || "Appointment"}</h3>
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="muted small" style={{ marginTop: 4 }}>{fmt(ev.startAt)}{ev.durationMin ? ` · ${ev.durationMin} min` : ""}</div>
        <dl className="fields" style={{ marginTop: 10 }}>
          <div className="field-row"><dt>Assigned to</dt><dd>👤 {ev.userName || "—"}</dd></div>
          {ev.closerName && <div className="field-row"><dt>Closer</dt><dd>{ev.closerName}</dd></div>}
          {ev.address && <div className="field-row"><dt>Address</dt><dd>{ev.address}</dd></div>}
          {ev.apptStatus && <div className="field-row"><dt>Status</dt><dd>{APPT_LABEL[ev.apptStatus] || ev.apptStatus}</dd></div>}
        </dl>
        {(ev.notes || ev.apptNotes) && <div className="muted small" style={{ marginTop: 6 }}>📝 {ev.apptNotes || ev.notes}</div>}

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
